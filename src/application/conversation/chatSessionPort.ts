import type { ConversationImage, RecordedToolCall } from '../../domain/conversation/events'
import type { CommitAssistantMessage, ReviseAssistantMessage } from './assistantMessageCoordinator'

/**
 * Transitional boundary used while conversation execution moves out of ChatStore.
 * It keeps the chat workflow independent from Pinia's SessionStore module.
 */
export interface ChatSessionPort {
  currentSessionId(): string
  workspaceGrantId(): string | null
  acceptUserMessage(message: {
    sessionId: string
    messageId: string
    text: string
    images: ConversationImage[]
  }): Promise<boolean>
  recordToolCalls(step: {
    sessionId: string
    stepId: string
    calls: RecordedToolCall[]
    visibleText?: string
  }): Promise<boolean>
  recordToolResult(result: {
    sessionId: string
    callId: string
    content: string
    status: 'succeeded' | 'failed' | 'rejected'
    code?: string
  }): Promise<boolean>
  commitAssistantMessage(message: CommitAssistantMessage): Promise<string | null>
  reviseAssistantMessage(message: ReviseAssistantMessage): Promise<boolean>
  beginCheckpoint(sessionId: string, messageId: string): Promise<string>
  backupFile(sessionId: string, checkpointId: string, relativePath: string): Promise<void>
  markCheckpointFiles(sessionId: string, checkpointId: string): Promise<void>
  clearConversation(sessionId: string): Promise<void>
}
