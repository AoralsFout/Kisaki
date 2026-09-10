import type {
  AssistantMessageCommitted,
  AssistantToolCallsProduced,
  ContextCompacted,
  ConversationEvent,
  ConversationImage,
  ConversationSessionSnapshot,
  ModelContextMessage,
  RecordedToolCall,
  SessionCheckpoint,
  ToolExecutionCompleted,
  UiTranscriptMessage,
  UserMessageAccepted,
} from './events'

export interface CreateSessionOptions {
  id: string
  title: string
  characterId?: string | null
  workspaceGrantId?: string | null
  now: number
}

export interface EventIdentity {
  eventId: string
  occurredAt: number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertEventShape(event: unknown): asserts event is ConversationEvent {
  if (!isRecord(event) || typeof event.type !== 'string') {
    throw new Error('Invalid conversation event')
  }
  if (typeof event.eventId !== 'string' || typeof event.occurredAt !== 'number') {
    throw new Error('Conversation event envelope is invalid')
  }
  const supported = new Set<ConversationEvent['type']>([
    'user-message-accepted',
    'assistant-tool-calls-produced',
    'tool-execution-completed',
    'assistant-message-committed',
    'context-compacted',
  ])
  if (!supported.has(event.type as ConversationEvent['type'])) {
    throw new Error(`Unsupported conversation event: ${event.type}`)
  }
  switch (event.type) {
    case 'user-message-accepted':
      if (typeof event.messageId !== 'string' || typeof event.text !== 'string' || !Array.isArray(event.images)) {
        throw new Error('User message event is invalid')
      }
      break
    case 'assistant-tool-calls-produced':
      if (typeof event.stepId !== 'string' || !Array.isArray(event.calls)) {
        throw new Error('Tool call event is invalid')
      }
      for (const call of event.calls) {
        if (!isRecord(call) || typeof call.id !== 'string' || typeof call.name !== 'string' || !isRecord(call.arguments)) {
          throw new Error('Recorded tool call is invalid')
        }
      }
      break
    case 'tool-execution-completed':
      if (
        typeof event.callId !== 'string'
        || typeof event.content !== 'string'
        || !['succeeded', 'failed', 'rejected'].includes(String(event.status))
      ) {
        throw new Error('Tool result event is invalid')
      }
      break
    case 'assistant-message-committed':
      if (
        typeof event.messageId !== 'string'
        || typeof event.display !== 'string'
        || !['say', 'text-fallback'].includes(String(event.source))
      ) {
        throw new Error('Assistant message event is invalid')
      }
      break
    case 'context-compacted':
      if (typeof event.summary !== 'string' || !Array.isArray(event.summarizedEventIds)) {
        throw new Error('Context compaction event is invalid')
      }
      break
  }
}

function assertSnapshotShape(value: unknown): asserts value is ConversationSessionSnapshot {
  if (!isRecord(value)) throw new Error('Session snapshot must be an object')
  if (typeof value.id !== 'string' || typeof value.title !== 'string') {
    throw new Error('Session identity is invalid')
  }
  if (!Array.isArray(value.timeline) || !Array.isArray(value.checkpoints)) {
    throw new Error('Session timeline or checkpoints are invalid')
  }
  if (!isRecord(value.contextState) || !Array.isArray(value.contextState.summarizedEventIds)) {
    throw new Error('Session context state is invalid')
  }
  if (value.contextState.summary !== null && typeof value.contextState.summary !== 'string') {
    throw new Error('Session context summary is invalid')
  }
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
    throw new Error('Session timestamps are invalid')
  }
  value.timeline.forEach(assertEventShape)
  for (const checkpoint of value.checkpoints) {
    if (
      !isRecord(checkpoint)
      || typeof checkpoint.id !== 'string'
      || typeof checkpoint.userMessageId !== 'string'
      || typeof checkpoint.createdAt !== 'number'
      || typeof checkpoint.hasWorkspaceChanges !== 'boolean'
    ) {
      throw new Error('Session checkpoint is invalid')
    }
  }
}

/**
 * The only mutable owner of one conversation session.
 * Consumers receive cloned snapshots or pure projections, never live arrays.
 */
export class SessionAggregate {
  private state: ConversationSessionSnapshot

  private constructor(snapshot: ConversationSessionSnapshot) {
    this.state = clone(snapshot)
    this.assertInvariants()
  }

  static create(options: CreateSessionOptions): SessionAggregate {
    assertNonEmpty(options.id, 'session id')
    assertNonEmpty(options.title, 'session title')
    return new SessionAggregate({
      id: options.id,
      title: options.title,
      characterId: options.characterId ?? null,
      workspaceGrantId: options.workspaceGrantId ?? null,
      timeline: [],
      checkpoints: [],
      contextState: { summary: null, summarizedEventIds: [] },
      createdAt: options.now,
      updatedAt: options.now,
    })
  }

  static restore(snapshot: unknown): SessionAggregate {
    assertSnapshotShape(snapshot)
    return new SessionAggregate(snapshot)
  }

  snapshot(): ConversationSessionSnapshot {
    return clone(this.state)
  }

  rename(title: string, now: number): void {
    assertNonEmpty(title, 'session title')
    this.state.title = title.trim()
    this.state.updatedAt = now
  }

  bindCharacter(characterId: string | null, now: number): void {
    this.state.characterId = characterId
    this.state.updatedAt = now
  }

  setWorkspaceGrant(workspaceGrantId: string | null, now: number): void {
    this.state.workspaceGrantId = workspaceGrantId
    this.state.updatedAt = now
  }

  acceptUserMessage(
    identity: EventIdentity,
    input: { messageId: string; text: string; images?: ConversationImage[] },
  ): void {
    if (!input.text.trim() && !input.images?.length) {
      throw new Error('User message must contain text or images')
    }
    this.append({
      ...identity,
      type: 'user-message-accepted',
      messageId: input.messageId,
      text: input.text,
      images: clone(input.images ?? []),
    } satisfies UserMessageAccepted)
  }

  recordToolCalls(
    identity: EventIdentity,
    input: { stepId: string; calls: RecordedToolCall[]; visibleText?: string },
  ): void {
    if (input.calls.length === 0) throw new Error('Tool call batch must not be empty')
    const ids = new Set(input.calls.map(call => call.id))
    if (ids.size !== input.calls.length) throw new Error('Tool call ids must be unique within a batch')
    for (const call of input.calls) {
      assertNonEmpty(call.id, 'tool call id')
      assertNonEmpty(call.name, 'tool call name')
      if (this.hasToolCall(call.id)) throw new Error(`Duplicate tool call id: ${call.id}`)
    }
    this.append({
      ...identity,
      type: 'assistant-tool-calls-produced',
      stepId: input.stepId,
      calls: clone(input.calls),
      visibleText: input.visibleText,
    } satisfies AssistantToolCallsProduced)
  }

  recordToolResult(
    identity: EventIdentity,
    input: Omit<ToolExecutionCompleted, keyof EventIdentity | 'type'>,
  ): void {
    if (!this.hasToolCall(input.callId)) throw new Error(`Unknown tool call id: ${input.callId}`)
    if (this.hasToolResult(input.callId)) throw new Error(`Tool result already recorded: ${input.callId}`)
    this.append({ ...identity, type: 'tool-execution-completed', ...input })
  }

  commitAssistantMessage(
    identity: EventIdentity,
    input: Omit<AssistantMessageCommitted, keyof EventIdentity | 'type'>,
  ): void {
    assertNonEmpty(input.display, 'assistant display text')
    this.append({ ...identity, type: 'assistant-message-committed', ...input })
  }

  compactContext(
    identity: EventIdentity,
    input: Omit<ContextCompacted, keyof EventIdentity | 'type'>,
  ): void {
    assertNonEmpty(input.summary, 'context summary')
    const known = new Set(this.state.timeline.map(event => event.eventId))
    if (input.summarizedEventIds.some(id => !known.has(id))) {
      throw new Error('Context compaction references an unknown event')
    }
    this.append({ ...identity, type: 'context-compacted', ...clone(input) })
    this.state.contextState = {
      summary: input.summary,
      summarizedEventIds: [...input.summarizedEventIds],
    }
  }

  addCheckpoint(checkpoint: SessionCheckpoint, now: number): void {
    if (this.state.checkpoints.some(item => item.id === checkpoint.id)) {
      throw new Error(`Duplicate checkpoint id: ${checkpoint.id}`)
    }
    const userExists = this.state.timeline.some(event => (
      event.type === 'user-message-accepted' && event.messageId === checkpoint.userMessageId
    ))
    if (!userExists) throw new Error(`Unknown checkpoint user message: ${checkpoint.userMessageId}`)
    this.state.checkpoints.push(clone(checkpoint))
    this.state.updatedAt = now
  }

  projectTranscript(): UiTranscriptMessage[] {
    const messages: UiTranscriptMessage[] = []
    for (const event of this.state.timeline) {
      if (event.type === 'user-message-accepted') {
        messages.push({
          id: event.messageId,
          role: 'user',
          text: event.text,
          occurredAt: event.occurredAt,
          images: event.images.length ? clone(event.images) : undefined,
        })
      } else if (event.type === 'assistant-message-committed') {
        messages.push({
          id: event.messageId,
          role: 'assistant',
          text: event.display,
          voice: event.voice,
          occurredAt: event.occurredAt,
        })
      }
    }
    return messages
  }

  projectModelContext(): ModelContextMessage[] {
    const context: ModelContextMessage[] = []
    if (this.state.contextState.summary) {
      context.push({ role: 'system', content: this.state.contextState.summary })
    }
    const summarized = new Set(this.state.contextState.summarizedEventIds)
    for (const event of this.state.timeline) {
      if (summarized.has(event.eventId) || event.type === 'context-compacted') continue
      switch (event.type) {
        case 'user-message-accepted':
          context.push({ role: 'user', content: event.text })
          break
        case 'assistant-tool-calls-produced':
          context.push({ role: 'assistant', content: event.visibleText ?? '', toolCalls: clone(event.calls) })
          break
        case 'tool-execution-completed':
          context.push({ role: 'tool', content: event.content, toolCallId: event.callId })
          break
        case 'assistant-message-committed':
          if (event.source === 'text-fallback') context.push({ role: 'assistant', content: event.display })
          break
      }
    }
    return context
  }

  private append(event: ConversationEvent): void {
    assertNonEmpty(event.eventId, 'event id')
    if (this.state.timeline.some(item => item.eventId === event.eventId)) {
      throw new Error(`Duplicate event id: ${event.eventId}`)
    }
    this.state.timeline.push(clone(event))
    this.state.updatedAt = Math.max(this.state.updatedAt, event.occurredAt)
  }

  private hasToolCall(callId: string): boolean {
    return this.state.timeline.some(event => (
      event.type === 'assistant-tool-calls-produced'
      && event.calls.some(call => call.id === callId)
    ))
  }

  private hasToolResult(callId: string): boolean {
    return this.state.timeline.some(event => (
      event.type === 'tool-execution-completed' && event.callId === callId
    ))
  }

  private assertInvariants(): void {
    assertNonEmpty(this.state.id, 'session id')
    assertNonEmpty(this.state.title, 'session title')
    const eventIds = this.state.timeline.map(event => event.eventId)
    if (new Set(eventIds).size !== eventIds.length) throw new Error('Session contains duplicate event ids')

    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const event of this.state.timeline) {
      if (event.type === 'assistant-tool-calls-produced') {
        for (const call of event.calls) {
          if (callIds.has(call.id)) throw new Error(`Session contains duplicate tool call id: ${call.id}`)
          callIds.add(call.id)
        }
      }
      if (event.type === 'tool-execution-completed') {
        if (!callIds.has(event.callId)) throw new Error(`Session contains orphan tool result: ${event.callId}`)
        if (resultIds.has(event.callId)) throw new Error(`Session contains duplicate tool result: ${event.callId}`)
        resultIds.add(event.callId)
      }
    }
  }
}
