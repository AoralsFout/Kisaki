/**
 * 模型上下文端口的适配器，建在既有的 `ChatContext` 之上。
 *
 * 端口只覆盖一次请求要发给模型的消息、追加与统计，形状里没有 replace / reset。
 * 那是刻意的：底层的 `ChatContext` 会被整体替换（清空对话、切换会话、模型配置变更三处），
 * 而「什么时候换、换成什么预算」属于装配，不属于回合。
 *
 * 替换因此落在适配器里，作为端口之外的方法：`reset()` 按当前模型配置换一个空的底层上下文，
 * 等价于迁移前 store 里的 `chatContext = createChatContext()`；需要保留内容时由调用方
 * 先 `snapshot()`、换完之后 `restore()`。适配器比端口宽不违反契约 —— 端口是缝，
 * 适配器可以更宽。
 */
import { ChatContext } from '../../ai/context'
import type { ChatContextInspection, ChatContextSnapshot, ContextStats } from '../../ai/context'
import { loadConfig } from '../../ai/client'
import type { ChatMessage } from '../../ai/types'
import type { ToolDefinition } from '../../agent/types'
import type { ConversationImage } from '../../domain/conversation/events'
import type { ProtocolToolCall } from '../../application/conversation/toolCallBatch'
import type { ConversationModelContext } from '../../application/conversation/conversationSession'

/**
 * 按当前模型配置构建 ChatContext。
 *
 * 模型决定上下文预算与轮数，所以每次替换都要重读一次配置；
 * 迁移前这条规则是 ChatStore 里的本地函数。
 */
export function createConfiguredChatContext(): ChatContext {
  const cfg = loadConfig()
  if (cfg.model) {
    return new ChatContext({ model: cfg.model })
  }
  return new ChatContext()
}

/** 恢复用户图片所需的回合视图：文本与它带来的图片按用户消息顺序配对。 */
export interface ConversationUserTurn {
  text: string
  images?: readonly ConversationImage[]
}

export class ChatContextModelContext implements ConversationModelContext {
  private context: ChatContext

  constructor(private readonly createContext: () => ChatContext = createConfiguredChatContext) {
    this.context = this.createContext()
  }

  // ── 端口 ────────────────────────────────────────────

  /** 本次请求要发给模型的消息。返回的是请求副本，调用方按需在其上追加。 */
  messages(tools: readonly ToolDefinition[]): readonly ChatMessage[] {
    return this.context.getMessages([...tools])
  }

  addUserMessage(text: string, images: readonly ConversationImage[]): void {
    this.context.addUserMessage(text, images)
  }

  addToolCalls(calls: readonly ProtocolToolCall[], visibleText?: string): void {
    this.context.addAssistantToolCall([...calls], visibleText)
  }

  addToolResult(callId: string, content: string): void {
    this.context.addToolResult(callId, content)
  }

  addToolImages(toolCallIds: string, images: readonly ConversationImage[]): void {
    this.context.addToolImages(toolCallIds, images)
  }

  stats(): ContextStats {
    return this.context.getStats()
  }

  // ── 端口之外：整体替换与上下文维护 ───────────────────

  /**
   * 按当前模型配置换一个空的底层上下文。
   * 清空对话、切换会话时调用；此后 `messages()` 只剩默认 system 提示。
   */
  reset(): void {
    this.context = this.createContext()
  }

  /** 设置自定义 system prompt；换上下文之后由调用方按当前角色重新应用。 */
  setSystemPrompt(
    prompt: string,
    voiceLang?: string,
    displayLang?: string,
    render?: 'illustration' | 'live2d',
  ): void {
    this.context.setSystemPrompt(prompt, voiceLang, displayLang, render)
  }

  /** 导出可持久化的脱敏快照（system prompt 不落盘）。 */
  snapshot(): ChatContextSnapshot {
    return this.context.exportSnapshot()
  }

  /** 恢复快照；版本不符或形状不对时返回 false，不抛错。 */
  restore(snapshot: ChatContextSnapshot | null | undefined): boolean {
    return this.context.importSnapshot(snapshot)
  }

  /** 从界面历史恢复用户图片（快照里不含 base64）。 */
  restoreUserImages(turns: readonly ConversationUserTurn[]): void {
    this.context.restoreUserImages(turns)
  }

  /** 上下文检查器视图：不触发裁剪、不修改统计状态。 */
  inspect(tools: readonly ToolDefinition[]): ChatContextInspection {
    return this.context.inspect([...tools])
  }
}
