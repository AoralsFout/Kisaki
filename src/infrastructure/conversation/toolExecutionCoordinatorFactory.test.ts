/**
 * 工具执行端口的工厂适配器：每回合构造一次协调器，并转接网关的待决状态。
 */
import { describe, expect, it } from 'vitest'
import { ApprovalGateway, type FileApprovalRequest } from '../../application/tools/approvalGateway'
import { ToolExecutionCoordinator } from '../../application/tools/toolExecutionCoordinator'
import { ToolExecutionCoordinatorFactory } from './toolExecutionCoordinatorFactory'

function fileRequest(): FileApprovalRequest {
  return {
    id: 'approval-1',
    toolName: 'write_file',
    args: {},
    kind: 'file',
    path: 'notes.txt',
    allowedDecisions: ['allow', 'allow-session', 'reject'],
  }
}

describe('ToolExecutionCoordinatorFactory', () => {
  it('每个回合拿到一个新的协调器，钩子由回合提供', () => {
    const factory = new ToolExecutionCoordinatorFactory(new ApprovalGateway())

    const first = factory.create({ checkpoint: async () => {} })
    const second = factory.create({ checkpoint: async () => {} })

    expect(first).toBeInstanceOf(ToolExecutionCoordinator)
    expect(second).not.toBe(first)
  })

  it('把网关的待决状态转成布尔量，订阅时立刻回报当前值', async () => {
    const gateway = new ApprovalGateway(60_000)
    const factory = new ToolExecutionCoordinatorFactory(gateway)
    const seen: boolean[] = []
    const unsubscribe = factory.subscribeApproval(pending => seen.push(pending))
    expect(seen).toEqual([false])

    const decision = gateway.request(fileRequest(), new AbortController().signal)
    expect(seen).toEqual([false, true])

    gateway.resolve('reject')
    await decision
    expect(seen).toEqual([false, true, false])

    unsubscribe()
    void gateway.request(fileRequest(), new AbortController().signal)
    expect(seen).toEqual([false, true, false])
    gateway.rejectPending()
  })
})
