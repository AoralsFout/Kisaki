/**
 * 工具边界的中立端口。
 *
 * 协议数据在 contracts.ts；这里放工具执行需要的能力端口和策略协议。
 * 本文件不得依赖 Agent 实现、应用编排、界面层或 Tauri。
 */
import type {
  ToolCall,
  ToolCharacterCapabilities,
  ToolCharacterData,
  ToolCharacterLook,
} from './contracts'

/** 角色工具运行时的事实快照。 */
export interface ToolCharacterRuntimeState {
  identity: { id: string; name: string } | null
  data: ToolCharacterData | null
  render: 'illustration' | 'live2d' | null
  look: ToolCharacterLook | null
  capabilities: ToolCharacterCapabilities | null
}

/** 角色工具运行时的最小能力面。 */
export interface ToolCharacterRuntimePort {
  state(): ToolCharacterRuntimeState
  setLook(change: Partial<Pick<ToolCharacterLook, 'emotion' | 'stance' | 'costume'>>): boolean
  setScreenPose(pose: string): boolean
  playMotion(group: string, index: number): Promise<boolean>
}

/** 一次工具执行的上下文；授权能力是唯一的工作区事实来源。 */
export interface ToolExecutionContext {
  signal: AbortSignal
  sessionApproval: boolean
  workspaceGrantId: string | null
  character?: ToolCharacterRuntimePort
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'reject'
export type ApprovalKind = 'file' | 'command' | 'screen-capture'

interface ApprovalRequestBase {
  id: string
  toolName: string
  args: Record<string, unknown>
  allowedDecisions: readonly ApprovalDecision[]
}

export interface FileApprovalRequest extends ApprovalRequestBase {
  kind: 'file'
  path: string
}

export interface CommandApprovalRequest extends ApprovalRequestBase {
  kind: 'command'
  summary: string
  details: unknown
}

export interface ScreenCaptureApprovalRequest extends ApprovalRequestBase {
  kind: 'screen-capture'
  target: 'cursor_monitor' | 'primary_monitor'
  includeKisaki: boolean
}

export type ApprovalRequest =
  | FileApprovalRequest
  | CommandApprovalRequest
  | ScreenCaptureApprovalRequest

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
