/**
 * 对话领域事件是权威的持久化历史。
 * UI 消息与模型协议消息都只是这条时间线的投影。
 */

export interface ConversationImage {
  id: string
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

export interface RecordedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface EventEnvelope {
  eventId: string
  occurredAt: number
}

export interface UserMessageAccepted extends EventEnvelope {
  type: 'user-message-accepted'
  messageId: string
  text: string
  images: ConversationImage[]
}

export interface AssistantToolCallsProduced extends EventEnvelope {
  type: 'assistant-tool-calls-produced'
  stepId: string
  calls: RecordedToolCall[]
  visibleText?: string
}

export interface ToolExecutionCompleted extends EventEnvelope {
  type: 'tool-execution-completed'
  callId: string
  content: string
  status: 'succeeded' | 'failed' | 'rejected'
  code?: string
}

export interface AssistantMessageCommitted extends EventEnvelope {
  type: 'assistant-message-committed'
  messageId: string
  display: string
  voice?: string
  source: 'say' | 'text-fallback'
}

export interface AssistantMessageRevised extends EventEnvelope {
  type: 'assistant-message-revised'
  messageId: string
  display?: string
  voice?: string
}

export interface ContextCompacted extends EventEnvelope {
  type: 'context-compacted'
  summary: string
  summarizedEventIds: string[]
}

export type ConversationEvent =
  | UserMessageAccepted
  | AssistantToolCallsProduced
  | ToolExecutionCompleted
  | AssistantMessageCommitted
  | AssistantMessageRevised
  | ContextCompacted

/** 角色的视觉状态：检查点记录的内容，也是会话记住的内容。 */
export interface CharacterLookSnapshot {
  emotion: string
  stance: string
  costume: string
  screenPose: string
}

export interface CheckpointCharacterSnapshot extends CharacterLookSnapshot {
  characterId: string | null
}

export interface SessionCheckpoint {
  id: string
  userMessageId: string
  createdAt: number
  hasWorkspaceChanges: boolean
  character: CheckpointCharacterSnapshot | null
}

export interface ContextState {
  summary: string | null
  summarizedEventIds: string[]
}

export interface ConversationSessionSnapshot {
  id: string
  title: string
  characterId: string | null
  characterLocked: boolean
  /**
   * 该会话离开时所处的外观。载入时恢复，使会话保留自己的
   * 情绪与位置，而不是回退到角色默认值。
   * 尚未存储过外观的会话为 null。
   */
  character: CharacterLookSnapshot | null
  workspaceGrantId: string | null
  timeline: ConversationEvent[]
  checkpoints: SessionCheckpoint[]
  contextState: ContextState
  createdAt: number
  updatedAt: number
}

export interface SessionDocument {
  schemaVersion: 2
  currentSessionId: string
  sessions: ConversationSessionSnapshot[]
}

export interface UiTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  occurredAt: number
  voice?: string
  images?: ConversationImage[]
}

export interface ModelContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: RecordedToolCall[]
  toolCallId?: string
}
