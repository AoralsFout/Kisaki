export type AssistantMessageSource = 'say' | 'text-fallback'

export interface CommitAssistantMessage {
  requestId: string
  sessionId: string
  display: string
  thinking?: string
  voice?: string
  source: AssistantMessageSource
  /** Present only when the voice has completed TTS-safe preparation. */
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
  commit(message: CommitAssistantMessage): string | null
  revise(message: ReviseAssistantMessage): boolean
}

type AssistantMessageListener = (event: AssistantMessageEvent) => void

/**
 * Defines the transaction boundary between conversation execution and session state.
 * Side effects subscribe only after the commit port accepts the canonical write.
 */
export class AssistantMessageCoordinator {
  private readonly listeners = new Set<AssistantMessageListener>()

  constructor(private readonly port: AssistantMessageCommitPort) {}

  subscribe(listener: AssistantMessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  commit(message: CommitAssistantMessage): AssistantMessageEvent | null {
    if (!message.display.trim()) throw new Error('Assistant display text must not be empty')
    const messageId = this.port.commit(message)
    if (!messageId) return null
    const event = { type: 'assistant-committed' as const, ...message, messageId }
    this.publish(event)
    return event
  }

  revise(message: ReviseAssistantMessage): AssistantMessageEvent | null {
    if (message.display === undefined && message.voice === undefined) {
      throw new Error('Assistant revision must contain display or voice')
    }
    if (!this.port.revise(message)) return null
    const event = { type: 'assistant-revised' as const, ...message }
    this.publish(event)
    return event
  }

  private publish(event: AssistantMessageEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
