import { describe, expect, it, vi } from 'vitest'
import { ApprovalGateway } from './approvalGateway'
import { ToolExecutionCoordinator, type ToolExecutionPolicy } from './toolExecutionCoordinator'

const call = { id: 'call-1', name: 'write_file', arguments: { path: 'a.txt' } }

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
})
