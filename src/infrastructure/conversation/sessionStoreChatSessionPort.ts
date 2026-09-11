/**
 * 会话事实端口（`ChatSessionPort`）的 Pinia 适配器。
 *
 * 端口实现由 SessionStore 提供（`createChatSessionPort()`），装配与注入由组合根完成：
 * store 不再在自己的函数体里调用 `setChatSessionPort(...)`。
 *
 * 为什么是延迟解析：`composeApplication()` 早于 `main.ts` 安装 Pinia，那一刻
 * `useSessionStore()` 没有活动实例；而 store 是单例，延迟到首次调用解析一次即可。
 * store 内的方法都是「调用时现取 store 状态」的形态，因此这个时机差对行为无影响。
 */
import type { ChatSessionPort } from '../../application/conversation/chatSessionPort'
import type { CommitAssistantMessage, ReviseAssistantMessage } from '../../application/conversation/assistantMessageCoordinator'
import type { ConversationImage, RecordedToolCall } from '../../domain/conversation/events'
import { useSessionStore } from '../../stores/session'

export class SessionStoreChatSessionPort implements ChatSessionPort {
  private resolved: ChatSessionPort | null = null

  private port(): ChatSessionPort {
    return this.resolved ??= useSessionStore().createChatSessionPort()
  }

  currentSessionId(): string {
    return this.port().currentSessionId()
  }

  workspaceGrantId(): string | null {
    return this.port().workspaceGrantId()
  }

  acceptUserMessage(message: {
    sessionId: string
    messageId: string
    text: string
    images: ConversationImage[]
  }): Promise<boolean> {
    return this.port().acceptUserMessage(message)
  }

  recordToolCalls(step: {
    sessionId: string
    stepId: string
    calls: RecordedToolCall[]
    visibleText?: string
  }): Promise<boolean> {
    return this.port().recordToolCalls(step)
  }

  recordToolResult(result: {
    sessionId: string
    callId: string
    content: string
    status: 'succeeded' | 'failed' | 'rejected'
    code?: string
  }): Promise<boolean> {
    return this.port().recordToolResult(result)
  }

  commitAssistantMessage(message: CommitAssistantMessage): Promise<string | null> {
    return this.port().commitAssistantMessage(message)
  }

  reviseAssistantMessage(message: ReviseAssistantMessage): Promise<boolean> {
    return this.port().reviseAssistantMessage(message)
  }

  beginCheckpoint(sessionId: string, messageId: string): Promise<string> {
    return this.port().beginCheckpoint(sessionId, messageId)
  }

  backupFile(sessionId: string, checkpointId: string, relativePath: string): Promise<void> {
    return this.port().backupFile(sessionId, checkpointId, relativePath)
  }

  markCheckpointFiles(sessionId: string, checkpointId: string): Promise<void> {
    return this.port().markCheckpointFiles(sessionId, checkpointId)
  }

  clearConversation(sessionId: string): Promise<void> {
    return this.port().clearConversation(sessionId)
  }
}
