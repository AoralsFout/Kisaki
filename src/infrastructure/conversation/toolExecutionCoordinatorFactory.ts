/**
 * 工具执行端口的工厂适配器。
 *
 * `ToolExecutionCoordinator` 的 `checkpoint` 回调绑定在本回合的 `checkpointId` 上
 * （迁移前 `chat.ts:838-853` 每回合 `new` 一次正是为此），所以它不能是组合根持有的单例。
 * 端口因此把「每回合构造一次」收进 `create()`：组合根只持有与回合无关的三份依赖
 * —— 批准网关、执行策略与执行器；检查点相关的三个钩子由回合自己提供。
 *
 * 待决批准状态也经这里转接：网关由组合根持有，回合只拿到「有没有待批准请求」这个布尔量，
 * 用来表达 awaiting-approval；待批准请求本身仍只经 `ApprovalGateway.subscribe` 暴露。
 */
import { agentService } from '../../agent/service'
import { toolExecutionPolicy } from '../../agent/toolExecutionPolicy'
import {
  ToolExecutionCoordinator,
  type ToolExecutionPolicy,
} from '../../application/tools/toolExecutionCoordinator'
import type { ApprovalGateway } from '../../application/tools/approvalGateway'
import type { ToolCall, ToolResult } from '../../agent/types'
import type {
  ConversationToolExecutionPort,
  ConversationToolRoundHooks,
} from '../../application/conversation/conversationSession'

export class ToolExecutionCoordinatorFactory implements ConversationToolExecutionPort {
  constructor(
    private readonly approvalGateway: ApprovalGateway,
    private readonly policy: ToolExecutionPolicy = toolExecutionPolicy,
    private readonly execute: (call: ToolCall) => Promise<ToolResult> = call => agentService.execute(call),
  ) {}

  create(round: ConversationToolRoundHooks): ToolExecutionCoordinator {
    return new ToolExecutionCoordinator({
      approvalGateway: this.approvalGateway,
      policy: this.policy,
      execute: call => this.execute(call),
      checkpoint: round.checkpoint,
      onCheckpointError: round.onCheckpointError,
      onSessionApproval: round.onSessionApproval,
    })
  }

  /**
   * 待决批准状态。订阅时立刻回报当前值，与网关自身的订阅语义一致。
   * 它是回合可见的唯一批准信号 —— 请求的值不进回合投影。
   */
  subscribeApproval(listener: (pending: boolean) => void): () => void {
    return this.approvalGateway.subscribe(request => listener(request !== null))
  }
}
