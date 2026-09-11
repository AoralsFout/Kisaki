export type AssistantMessageSource = 'say' | 'text-fallback'

export interface CommitAssistantMessage {
  requestId: string
  sessionId: string
  display: string
  thinking?: string
  voice?: string
  source: AssistantMessageSource
  /** 仅当语音已完成 TTS 安全预处理时才存在。 */
  playbackText?: string
}

export interface ReviseAssistantMessage {
  requestId: string
  sessionId: string
  messageId: string
  display?: string
  voice?: string
  playbackText?: string
}

export type AssistantMessageEvent =
  | ({ type: 'assistant-committed'; messageId: string } & CommitAssistantMessage)
  | ({ type: 'assistant-revised' } & ReviseAssistantMessage)

export interface AssistantMessageCommitPort {
  commit(message: CommitAssistantMessage): Promise<string | null>
  revise(message: ReviseAssistantMessage): Promise<boolean>
}

type AssistantMessageListener = (event: AssistantMessageEvent) => void

/**
 * 划定对话执行与会话状态之间的事务边界。
 * 只有提交端口接受这次权威写入之后，副作用才会被订阅。
 */
export class AssistantMessageCoordinator {
  private readonly listeners = new Set<AssistantMessageListener>()

  constructor(private readonly port: AssistantMessageCommitPort) {}

  subscribe(listener: AssistantMessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async commit(message: CommitAssistantMessage): Promise<AssistantMessageEvent | null> {
    if (!message.display.trim()) throw new Error('Assistant display text must not be empty')
    const messageId = await this.port.commit(message)
    if (!messageId) return null
    const event = { type: 'assistant-committed' as const, ...message, messageId }
    this.publish(event)
    return event
  }

  async revise(message: ReviseAssistantMessage): Promise<AssistantMessageEvent | null> {
    if (message.display === undefined && message.voice === undefined) {
      throw new Error('Assistant revision must contain display or voice')
    }
    if (!await this.port.revise(message)) return null
    const event = { type: 'assistant-revised' as const, ...message }
    this.publish(event)
    return event
  }

  private publish(event: AssistantMessageEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
