import type { ToolCall, ToolResult } from '../../agent/types'
import type { ApprovalGateway, ApprovalRequest } from './approvalGateway'

export interface ToolExecutionContext {
  signal: AbortSignal
  sessionApproval: boolean
  hasWorkspace: boolean
}

export interface PreparedToolExecution {
  call: ToolCall
  approval?: ApprovalRequest
  checkpointPath?: string
  authorize?: () => Promise<ToolCall>
}

export interface ToolExecutionPolicy {
  prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedToolExecution>
}

export class ToolExecutionFailure extends Error {
  constructor(
    readonly content: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(content)
  }
}

export interface ToolExecutionCoordinatorOptions {
  approvalGateway: ApprovalGateway
  policy: ToolExecutionPolicy
  execute: (call: ToolCall) => Promise<ToolResult>
  checkpoint?: (path: string) => Promise<void>
  onCheckpointError?: (error: unknown, path: string) => void
  onSessionApproval?: () => void
}

/** Executes every tool through one ordered policy pipeline. */
export class ToolExecutionCoordinator {
  constructor(private readonly options: ToolExecutionCoordinatorOptions) {}

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) return this.failure(call, '工具执行已取消。', 'EXECUTION_CANCELLED', false)

    let prepared: PreparedToolExecution
    try {
      prepared = await this.options.policy.prepare(call, context)
    } catch (error) {
      return this.fromError(call, error, '工具准备失败', 'TOOL_PREPARATION_FAILED')
    }

    if (context.signal.aborted) return this.failure(call, '工具执行已取消。', 'EXECUTION_CANCELLED', false)

    if (prepared.approval) {
      const decision = await this.options.approvalGateway.request(prepared.approval, context.signal)
      if (decision === 'reject') {
        const target = prepared.approval.kind === 'screen-capture' ? '屏幕截图'
          : prepared.approval.kind === 'file' ? '文件操作'
            : '操作'
        return this.failure(call, `用户已拒绝${target}，未执行。`, 'USER_REJECTED', false)
      }
      if (decision === 'allow-session') this.options.onSessionApproval?.()
    }

    if (context.signal.aborted) return this.failure(call, '工具执行已取消。', 'EXECUTION_CANCELLED', false)

    if (prepared.authorize) {
      try {
        prepared.call = await prepared.authorize()
      } catch (error) {
        return this.fromError(call, error, '工具批准失败', 'TOOL_APPROVAL_FAILED')
      }
    }

    if (prepared.checkpointPath && this.options.checkpoint) {
      try {
        await this.options.checkpoint(prepared.checkpointPath)
      } catch (error) {
        this.options.onCheckpointError?.(error, prepared.checkpointPath)
      }
    }

    if (context.signal.aborted) return this.failure(call, '工具执行已取消。', 'EXECUTION_CANCELLED', false)
    return this.options.execute(prepared.call)
  }

  private fromError(call: ToolCall, error: unknown, prefix: string, code: string): ToolResult {
    if (error instanceof ToolExecutionFailure) {
      return this.failure(call, error.content, error.code, error.retryable)
    }
    const message = error instanceof Error ? error.message : String(error)
    return this.failure(call, `${prefix}: ${message}`, code, true)
  }

  private failure(call: ToolCall, content: string, code: string, retryable: boolean): ToolResult {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content,
      ok: false,
      code,
      retryable,
    }
  }
}
