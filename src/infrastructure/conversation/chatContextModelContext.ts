/**
 * 模型上下文端口的适配器，建在既有的 `ChatContext` 之上。
 *
 * 端口只覆盖一次请求要发给模型的消息、追加与统计，形状里没有 replace / reset。
 * 那是刻意的：底层的 `ChatContext` 会被整体替换（清空对话、切换会话、模型配置变更三处），
 * 而「什么时候换、换成什么预算」属于装配，不属于回合。
 *
 * 替换因此落在适配器里，作为端口之外的方法：`reset()` 按当前模型配置换一个空的底层上下文，
 * `loadModelProjection()` 直接装载会话时间线投影。适配器比端口宽不违反契约 —— 端口是缝，适配器可以更宽。
 */
import { ChatContext } from '../../ai/context'
import type { ChatContextInspection, ContextStats } from '../../ai/context'
import { loadConfig } from '../../ai/client'
import type { ChatMessage } from '../../ai/types'
import type { ToolDefinition } from '../../domain/tools/contracts'
import type { ConversationImage, ModelContextMessage, ModelHistoryCompaction, ModelHistoryStats } from '../../domain/conversation/events'
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

/** ChatContext 裁剪后交给会话事实端口的摘要结果。 */
export type ConversationContextCompactionListener = (compaction: ModelHistoryCompaction) => void

export class ChatContextModelContext implements ConversationModelContext {
  private context: ChatContext

  constructor(
    private readonly createContext: () => ChatContext = createConfiguredChatContext,
    private readonly onCompaction?: ConversationContextCompactionListener,
  ) {
    this.context = this.createContext()
  }

  // ── 端口 ────────────────────────────────────────────

  /** 本次请求要发给模型的消息。返回的是请求副本，调用方按需在其上追加。 */
  messages(tools: readonly ToolDefinition[]): readonly ChatMessage[] {
    const before = this.context.getCompactionState()
    try {
      return this.context.getMessages([...tools])
    } finally {
      // 即使当前请求最终因预算不足失败，ChatContext 也可能已经完成了裁剪；
      // 这份摘要仍必须进入会话事实，避免实时上下文与模型历史脱节。
      const after = this.context.getCompactionState()
      if (after.summary && (
        after.summary !== before.summary
        || after.summarizedRounds !== before.summarizedRounds
      )) {
        this.onCompaction?.({
          summary: after.summary,
          summarizedRounds: after.summarizedRounds,
        })
      }
    }
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

  /** 消息事实提交后把 say 调用绑定到持久化 message id。 */
  bindAssistantMessage(messageId: string): void {
    this.context.bindAssistantMessage(messageId)
  }

  /** 消息事实修订成功后同步实时模型上下文。 */
  reviseAssistantMessage(messageId: string, revision: { display?: string; voice?: string }): void {
    this.context.reviseAssistantMessage(messageId, revision)
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

  /** 直接装载会话时间线的模型协议投影，避免快照往返。 */
  loadModelProjection(
    projection: readonly ModelContextMessage[],
    stats: ModelHistoryStats = { summarizedRounds: 0 },
  ): void {
    const summary = projection.find(message => message.role === 'system')
    const history = projection
      .filter(message => message.role !== 'system')
      .map(toChatMessage)
    this.context.replaceHistory(
      history,
      typeof summary?.content === 'string' ? summary.content : '',
      stats.summarizedRounds,
    )
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

  /** 上下文检查器视图：在副本上预演裁剪，不修改真实上下文或统计状态。 */
  inspect(tools: readonly ToolDefinition[]): ChatContextInspection {
    return this.context.inspect([...tools])
  }
}

function toChatMessage(message: ModelContextMessage): ChatMessage {
  return {
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map(part => part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { ...part.image_url } }),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      }
      : {}),
  }
}
