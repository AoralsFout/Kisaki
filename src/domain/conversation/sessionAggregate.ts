import type {
  AssistantMessageCommitted,
  AssistantMessageRevised,
  AssistantToolCallsProduced,
  CharacterLookSnapshot,
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

export interface SessionRollbackResult {
  targetCheckpoint: SessionCheckpoint | null
  removedCheckpointIds: string[]
  workspaceCheckpointIdsNewestFirst: string[]
}

export interface ClearedConversationResult {
  workspaceCheckpointIdsNewestFirst: string[]
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

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function assertCharacterLookShape(value: unknown, label: string): void {
  if (
    !isRecord(value)
    || typeof value.emotion !== 'string'
    || typeof value.stance !== 'string'
    || typeof value.costume !== 'string'
    || typeof value.screenPose !== 'string'
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function assertCheckpointShape(checkpoint: unknown): asserts checkpoint is SessionCheckpoint {
  if (
    !isRecord(checkpoint)
    || typeof checkpoint.id !== 'string'
    || typeof checkpoint.userMessageId !== 'string'
    || typeof checkpoint.createdAt !== 'number'
    || typeof checkpoint.hasWorkspaceChanges !== 'boolean'
  ) {
    throw new Error('Session checkpoint is invalid')
  }
  if (checkpoint.character === null) return
  if (!isRecord(checkpoint.character) || !isNullableString(checkpoint.character.characterId)) {
    throw new Error('Session checkpoint character snapshot is invalid')
  }
  assertCharacterLookShape(checkpoint.character, 'Session checkpoint character snapshot')
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
    'assistant-message-revised',
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
    case 'assistant-message-revised':
      if (
        typeof event.messageId !== 'string'
        || (event.display === undefined && event.voice === undefined)
        || (event.display !== undefined && typeof event.display !== 'string')
        || (event.voice !== undefined && typeof event.voice !== 'string')
      ) {
        throw new Error('Assistant message revision event is invalid')
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
  if (
    !isNullableString(value.characterId)
    || typeof value.characterLocked !== 'boolean'
    || !isNullableString(value.workspaceGrantId)
  ) {
    throw new Error('Session bindings are invalid')
  }
  // 在会话尚未记住外观之前写入的文档没有该字段；按 null 读取。
  if (value.character !== undefined && value.character !== null) {
    assertCharacterLookShape(value.character, 'Session character look')
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
  value.checkpoints.forEach(assertCheckpointShape)
}

/**
 * 一个对话会话唯一可变状态的持有者。
 * 消费方拿到的是克隆后的快照或纯投影，绝不会是活数组。
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
      characterLocked: false,
      character: null,
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
    return new SessionAggregate({ ...snapshot, character: snapshot.character ?? null })
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
    if (this.state.characterLocked && characterId !== this.state.characterId) {
      throw new Error('Cannot change character after the conversation has started')
    }
    // 换角色时不得沿用上一个角色的外观标签。
    if (characterId !== this.state.characterId) this.state.character = null
    this.state.characterId = characterId
    this.state.updatedAt = now
  }

  /** 记住会话离开时的外观，载入该会话时即可恢复。 */
  setCharacterState(character: CharacterLookSnapshot | null, now: number): void {
    if (character !== null) assertCharacterLookShape(character, 'Session character look')
    this.state.character = clone(character)
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
    this.state.characterLocked = true
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

  reviseAssistantMessage(
    identity: EventIdentity,
    input: Omit<AssistantMessageRevised, keyof EventIdentity | 'type'>,
  ): void {
    if (input.display === undefined && input.voice === undefined) {
      throw new Error('Assistant message revision must contain display or voice')
    }
    if (!this.hasAssistantMessage(input.messageId)) {
      throw new Error(`Unknown assistant message id: ${input.messageId}`)
    }
    this.append({ ...identity, type: 'assistant-message-revised', ...input })
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
    if (this.state.checkpoints.some(item => item.userMessageId === checkpoint.userMessageId)) {
      throw new Error(`Checkpoint already exists for user message: ${checkpoint.userMessageId}`)
    }
    this.state.checkpoints.push(clone(checkpoint))
    this.state.updatedAt = now
  }

  markCheckpointWorkspaceChanges(checkpointId: string, now: number): void {
    const checkpoint = this.state.checkpoints.find(item => item.id === checkpointId)
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`)
    checkpoint.hasWorkspaceChanges = true
    this.state.updatedAt = now
  }

  clearConversation(now: number): ClearedConversationResult {
    const workspaceCheckpointIdsNewestFirst = [...this.state.checkpoints]
      .filter(checkpoint => checkpoint.hasWorkspaceChanges)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(checkpoint => checkpoint.id)
    this.state.timeline = []
    this.state.checkpoints = []
    this.state.contextState = { summary: null, summarizedEventIds: [] }
    this.state.updatedAt = now
    return { workspaceCheckpointIdsNewestFirst }
  }

  rollbackToUserMessage(messageId: string, now: number): SessionRollbackResult {
    const targetIndex = this.state.timeline.findIndex(event => (
      event.type === 'user-message-accepted' && event.messageId === messageId
    ))
    if (targetIndex < 0) throw new Error(`Unknown rollback user message: ${messageId}`)

    const userEventIndexes = new Map<string, number>()
    this.state.timeline.forEach((event, index) => {
      if (event.type === 'user-message-accepted') userEventIndexes.set(event.messageId, index)
    })

    const removedCheckpoints = this.state.checkpoints.filter(checkpoint => (
      (userEventIndexes.get(checkpoint.userMessageId) ?? Number.POSITIVE_INFINITY) >= targetIndex
    ))
    const targetCheckpoint = removedCheckpoints.find(checkpoint => checkpoint.userMessageId === messageId) ?? null
    const workspaceCheckpointIdsNewestFirst = removedCheckpoints
      .filter(checkpoint => checkpoint.hasWorkspaceChanges)
      .sort((left, right) => (
        (userEventIndexes.get(right.userMessageId) ?? 0)
        - (userEventIndexes.get(left.userMessageId) ?? 0)
      ))
      .map(checkpoint => checkpoint.id)

    this.state.timeline = this.state.timeline.slice(0, targetIndex)
    this.state.checkpoints = this.state.checkpoints.filter(checkpoint => (
      (userEventIndexes.get(checkpoint.userMessageId) ?? Number.POSITIVE_INFINITY) < targetIndex
    ))
    this.restoreLatestContextState()
    this.state.updatedAt = now
    this.assertInvariants()

    return {
      targetCheckpoint: targetCheckpoint ? clone(targetCheckpoint) : null,
      removedCheckpointIds: removedCheckpoints.map(checkpoint => checkpoint.id),
      workspaceCheckpointIdsNewestFirst,
    }
  }

  projectTranscript(): UiTranscriptMessage[] {
    const messages: UiTranscriptMessage[] = []
    const assistantIndexes = new Map<string, number>()
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
        assistantIndexes.set(event.messageId, messages.length)
        messages.push({
          id: event.messageId,
          role: 'assistant',
          text: event.display,
          voice: event.voice,
          occurredAt: event.occurredAt,
        })
      } else if (event.type === 'assistant-message-revised') {
        const index = assistantIndexes.get(event.messageId)
        if (index === undefined) continue
        if (event.display !== undefined) messages[index].text = event.display
        if (event.voice !== undefined) messages[index].voice = event.voice
      }
    }
    return messages
  }

  projectModelContext(): ModelContextMessage[] {
    const context: ModelContextMessage[] = []
    const fallbackIndexes = new Map<string, number>()
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
          if (event.source === 'text-fallback') {
            fallbackIndexes.set(event.messageId, context.length)
            context.push({ role: 'assistant', content: event.display })
          }
          break
        case 'assistant-message-revised': {
          const index = fallbackIndexes.get(event.messageId)
          if (index !== undefined && event.display !== undefined) context[index].content = event.display
          break
        }
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

  private hasAssistantMessage(messageId: string): boolean {
    return this.state.timeline.some(event => (
      event.type === 'assistant-message-committed' && event.messageId === messageId
    ))
  }

  private restoreLatestContextState(): void {
    const compaction = [...this.state.timeline]
      .reverse()
      .find((event): event is ContextCompacted => event.type === 'context-compacted')
    this.state.contextState = compaction
      ? { summary: compaction.summary, summarizedEventIds: [...compaction.summarizedEventIds] }
      : { summary: null, summarizedEventIds: [] }
  }

  private assertInvariants(): void {
    assertNonEmpty(this.state.id, 'session id')
    assertNonEmpty(this.state.title, 'session title')
    const eventIds = this.state.timeline.map(event => event.eventId)
    if (new Set(eventIds).size !== eventIds.length) throw new Error('Session contains duplicate event ids')

    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    const messageIds = new Set<string>()
    const userMessageIds = new Set<string>()
    for (const event of this.state.timeline) {
      if (event.type === 'user-message-accepted' || event.type === 'assistant-message-committed') {
        if (messageIds.has(event.messageId)) throw new Error(`Session contains duplicate message id: ${event.messageId}`)
        messageIds.add(event.messageId)
      }
      if (event.type === 'user-message-accepted') userMessageIds.add(event.messageId)
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
      if (event.type === 'assistant-message-revised' && !messageIds.has(event.messageId)) {
        throw new Error(`Session contains orphan assistant message revision: ${event.messageId}`)
      }
    }
    const checkpointIds = new Set<string>()
    const checkpointUserMessageIds = new Set<string>()
    for (const checkpoint of this.state.checkpoints) {
      if (checkpointIds.has(checkpoint.id)) throw new Error(`Session contains duplicate checkpoint id: ${checkpoint.id}`)
      if (checkpointUserMessageIds.has(checkpoint.userMessageId)) {
        throw new Error(`Session contains duplicate checkpoint for user message: ${checkpoint.userMessageId}`)
      }
      if (!userMessageIds.has(checkpoint.userMessageId)) {
        throw new Error(`Session contains orphan checkpoint: ${checkpoint.id}`)
      }
      checkpointIds.add(checkpoint.id)
      checkpointUserMessageIds.add(checkpoint.userMessageId)
    }
    if (userMessageIds.size > 0 && !this.state.characterLocked) {
      throw new Error('Session with user messages must have a locked character')
    }
  }
}
