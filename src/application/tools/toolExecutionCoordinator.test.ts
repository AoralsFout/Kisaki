import { describe, expect, it, vi } from 'vitest'
import { ApprovalGateway } from './approvalGateway'
import { ToolExecutionCoordinator, type ToolExecutionPolicy } from './toolExecutionCoordinator'

const call = { id: 'call-1', name: 'write_file', arguments: { path: 'a.txt' } }

/** 手动放行的异步闸门：用来把取消精确落在某一段 await 期间。 */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('ToolExecutionCoordinator', () => {
  it('runs policy, approval, checkpoint, and handler in a fixed order', async () => {
    const order: string[] = []
    const gateway = new ApprovalGateway()
    const policy: ToolExecutionPolicy = {
      prepare: vi.fn(async input => {
        order.push('precondition')
        return {
          call: input,
          approval: {
            kind: 'file' as const, id: input.id, toolName: input.name, args: input.arguments,
            path: 'a.txt', allowedDecisions: ['allow', 'allow-session', 'reject'] as const,
          },
          authorize: async () => {
            order.push('authorize')
            return { ...input, arguments: { ...input.arguments, token: 'approved' } }
          },
          checkpointPath: 'a.txt',
        }
      }),
    }
    gateway.subscribe(request => { if (request) { order.push('approval'); gateway.resolve('allow') } })
    const coordinator = new ToolExecutionCoordinator({
      approvalGateway: gateway,
      policy,
      checkpoint: async () => { order.push('checkpoint') },
      execute: async input => {
        order.push('handler')
        return { role: 'tool', tool_call_id: input.id, content: 'ok', ok: true }
      },
    })

    const result = await coordinator.execute(call, { signal: new AbortController().signal, sessionApproval: false, hasWorkspace: true })

    expect(result.ok).toBe(true)
    expect(order).toEqual(['precondition', 'approval', 'authorize', 'checkpoint', 'handler'])
  })

  it('never checkpoints or executes after rejection', async () => {
    const gateway = new ApprovalGateway()
    gateway.subscribe(request => { if (request) gateway.resolve('reject') })
    const checkpoint = vi.fn()
    const execute = vi.fn()
    const coordinator = new ToolExecutionCoordinator({
      approvalGateway: gateway,
      policy: {
        prepare: async input => ({
          call: input,
          approval: {
            kind: 'file', id: input.id, toolName: input.name, args: input.arguments,
            path: 'a.txt', allowedDecisions: ['allow', 'allow-session', 'reject'],
          },
          checkpointPath: 'a.txt',
        }),
      },
      checkpoint,
      execute,
    })

    const result = await coordinator.execute(call, { signal: new AbortController().signal, sessionApproval: false, hasWorkspace: true })

    expect(result).toMatchObject({ ok: false, code: 'USER_REJECTED' })
    expect(checkpoint).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('continues after a checkpoint failure and reports it once', async () => {
    const onCheckpointError = vi.fn()
    const execute = vi.fn(async input => ({ role: 'tool' as const, tool_call_id: input.id, content: 'ok', ok: true }))
    const coordinator = new ToolExecutionCoordinator({
      approvalGateway: new ApprovalGateway(),
      policy: { prepare: async input => ({ call: input, checkpointPath: 'a.txt' }) },
      checkpoint: async () => { throw new Error('backup failed') },
      onCheckpointError,
      execute,
    })

    const result = await coordinator.execute(call, { signal: new AbortController().signal, sessionApproval: true, hasWorkspace: true })

    expect(result.ok).toBe(true)
    expect(onCheckpointError).toHaveBeenCalledWith(expect.any(Error), 'a.txt')
    expect(execute).toHaveBeenCalledOnce()
  })

  /**
   * 取消回执（`EXECUTION_CANCELLED`）的契约与可达性。
   *
   * 可达性：三处中止检查分别挡在策略准备、批准等待/授权/检查点与最终执行之前，
   * 取消落在任一段 await 期间都会命中。它经由回合缝走到 `commitToolResult` 时，
   * 反过来会先撞上「已失去投影权」而整轮终止 —— 因此这条回执既不落库也不进模型上下文
   * （见 `conversationSession.test.ts` 的「执行中被取消」用例）。
   *
   * 但它本身是承重的，不是可以删掉的多余分支：把工具执行排空到一个「取消后可观察的回执」
   * 上，比让已取消的回合继续产生副作用（写文件、跑命令、截图）要安全得多。
   * 所以这里按端口契约把它固定下来，而不是因为回执不可观察就删掉。
   */
  describe('EXECUTION_CANCELLED', () => {
    const context = (controller: AbortController) => ({
      signal: controller.signal,
      sessionApproval: true,
      hasWorkspace: true,
    })

    it('取消于开始之前：不准备、不检查点、不执行', async () => {
      const prepare = vi.fn(async (input: typeof call) => ({ call: input, checkpointPath: 'a.txt' }))
      const checkpoint = vi.fn()
      const execute = vi.fn()
      const controller = new AbortController()
      const coordinator = new ToolExecutionCoordinator({
        approvalGateway: new ApprovalGateway(),
        policy: { prepare },
        checkpoint,
        execute,
      })
      controller.abort('user-cancelled')

      const result = await coordinator.execute(call, context(controller))

      expect(result).toEqual({
        role: 'tool',
        tool_call_id: 'call-1',
        content: '工具执行已取消。',
        ok: false,
        code: 'EXECUTION_CANCELLED',
        retryable: false,
      })
      expect(prepare).not.toHaveBeenCalled()
      expect(checkpoint).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    })

    it('取消于策略准备期间：检查点与执行都不再发生', async () => {
      // 这是回合缝里「执行中被取消」的形状：sending 的取消落在 prepare 的 await 上。
      const gate = deferred()
      const prepare = vi.fn(async (input: typeof call) => {
        await gate.promise
        return { call: input, checkpointPath: 'a.txt' }
      })
      const checkpoint = vi.fn()
      const execute = vi.fn()
      const controller = new AbortController()
      const coordinator = new ToolExecutionCoordinator({
        approvalGateway: new ApprovalGateway(),
        policy: { prepare },
        checkpoint,
        execute,
      })

      const running = coordinator.execute(call, context(controller))
      controller.abort('user-cancelled')
      gate.resolve()

      await expect(running).resolves.toMatchObject({ code: 'EXECUTION_CANCELLED', retryable: false })
      expect(prepare).toHaveBeenCalledOnce()
      expect(checkpoint).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    })

    it('取消于检查点期间：执行不再发生', async () => {
      const gate = deferred()
      const checkpointStarted = deferred()
      const execute = vi.fn()
      const controller = new AbortController()
      const coordinator = new ToolExecutionCoordinator({
        approvalGateway: new ApprovalGateway(),
        policy: { prepare: async input => ({ call: input, checkpointPath: 'a.txt' }) },
        checkpoint: async () => {
          checkpointStarted.resolve()
          await gate.promise
        },
        execute,
      })

      const running = coordinator.execute(call, context(controller))
      await checkpointStarted.promise
      controller.abort('user-cancelled')
      gate.resolve()

      await expect(running).resolves.toMatchObject({ code: 'EXECUTION_CANCELLED', retryable: false })
      expect(execute).not.toHaveBeenCalled()
    })

    it('取消于批准等待期间：网关按既有语义回 reject，工具同样不执行', async () => {
      // 这条路径给的是 USER_REJECTED 而非 EXECUTION_CANCELLED：中止信号被网关先一步
      // 消费成「拒绝」。两者对调用方的可观察后果一致（都不执行、都不可重试）。
      const execute = vi.fn()
      const gateway = new ApprovalGateway()
      const controller = new AbortController()
      const coordinator = new ToolExecutionCoordinator({
        approvalGateway: gateway,
        policy: {
          prepare: async input => ({
            call: input,
            approval: {
              kind: 'file' as const, id: input.id, toolName: input.name, args: input.arguments,
              path: 'a.txt', allowedDecisions: ['allow', 'allow-session', 'reject'] as const,
            },
          }),
        },
        execute,
      })
      // 请求一发布就取消：等价于用户在批准卡出现的同时按下停止。
      gateway.subscribe(request => { if (request) controller.abort('user-cancelled') })

      const result = await coordinator.execute(call, context(controller))

      expect(result).toMatchObject({ ok: false, code: 'USER_REJECTED', retryable: false })
      expect(execute).not.toHaveBeenCalled()
    })
  })
})
