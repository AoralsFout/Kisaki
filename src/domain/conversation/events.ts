/**
 * Conversation domain events are the canonical persisted history.
 * UI messages and model protocol messages are projections of this timeline.
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
  | ContextCompacted

export interface SessionCheckpoint {
  id: string
  userMessageId: string
  createdAt: number
  hasWorkspaceChanges: boolean
}

export interface ContextState {
  summary: string | null
  summarizedEventIds: string[]
}

export interface ConversationSessionSnapshot {
  id: string
  title: string
  characterId: string | null
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
