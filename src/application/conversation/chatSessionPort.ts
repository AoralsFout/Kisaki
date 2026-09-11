import type { ConversationImage, RecordedToolCall } from '../../domain/conversation/events'
import type { CommitAssistantMessage, ReviseAssistantMessage } from './assistantMessageCoordinator'

/**
 * 会话事实端口：对话回合 ↔ 会话聚合之间的边界。
 *
 * 回合只经它提交用户消息、工具调用与助手消息，因此不依赖 Pinia 的 SessionStore 模块。
 * 唯一实现是 `SessionStoreChatSessionPort`，由组合根在装配对话对象图时构造并注入；
 * 缺装配即由 `ConversationSession` 构造失败，没有静默空转的回落实现。
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
