import type { ConversationImage, RecordedToolCall } from '../../domain/conversation/events'
import type { CommitAssistantMessage, ReviseAssistantMessage } from './assistantMessageCoordinator'

/**
 * 过渡期边界：对话执行逻辑正逐步移出 ChatStore。
 * 它让聊天流程不再依赖 Pinia 的 SessionStore 模块。
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
