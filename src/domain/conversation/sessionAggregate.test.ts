import { describe, expect, it } from 'vitest'
import { SessionAggregate } from './sessionAggregate'

function createSession() {
  return SessionAggregate.create({ id: 'session-1', title: 'New conversation', now: 10 })
}

describe('SessionAggregate', () => {
  it('uses one timeline to project UI messages and model protocol messages', () => {
    const session = createSession()
    session.acceptUserMessage(
      { eventId: 'event-user', occurredAt: 11 },
      { messageId: 'message-user', text: 'calculate', images: [] },
    )
    session.recordToolCalls(
      { eventId: 'event-calls', occurredAt: 12 },
      { stepId: 'step-1', calls: [{ id: 'call-1', name: 'calculator', arguments: { expression: '1+1' } }] },
    )
    session.recordToolResult(
      { eventId: 'event-result', occurredAt: 13 },
      { callId: 'call-1', content: '2', status: 'succeeded' },
    )
    session.commitAssistantMessage(
      { eventId: 'event-assistant', occurredAt: 14 },
      { messageId: 'message-assistant', display: 'The result is 2.', voice: 'The result is 2.', source: 'say' },
    )

    expect(session.projectTranscript()).toEqual([
      { id: 'message-user', role: 'user', text: 'calculate', occurredAt: 11, images: undefined },
      {
        id: 'message-assistant', role: 'assistant', text: 'The result is 2.',
        voice: 'The result is 2.', occurredAt: 14,
      },
    ])
    expect(session.projectModelContext()).toEqual([
      { role: 'user', content: 'calculate' },
      {
        role: 'assistant', content: '',
        toolCalls: [{ id: 'call-1', name: 'calculator', arguments: { expression: '1+1' } }],
      },
      { role: 'tool', content: '2', toolCallId: 'call-1' },
    ])
  })

  it('returns detached snapshots instead of exposing mutable aggregate state', () => {
    const session = createSession()
    const snapshot = session.snapshot()
    snapshot.title = 'mutated outside'
    snapshot.timeline.push({
      type: 'user-message-accepted',
      eventId: 'outside',
      occurredAt: 20,
      messageId: 'outside',
      text: 'outside',
      images: [],
    })

    expect(session.snapshot().title).toBe('New conversation')
    expect(session.snapshot().timeline).toEqual([])
  })

  it('rejects orphan and duplicate tool protocol events', () => {
    const session = createSession()
    expect(() => session.recordToolResult(
      { eventId: 'orphan-result', occurredAt: 11 },
      { callId: 'missing', content: 'orphan', status: 'failed' },
    )).toThrow('Unknown tool call id')

    session.recordToolCalls(
      { eventId: 'calls', occurredAt: 12 },
      { stepId: 'step', calls: [{ id: 'call', name: 'calculator', arguments: {} }] },
    )
    session.recordToolResult(
      { eventId: 'result', occurredAt: 13 },
      { callId: 'call', content: 'ok', status: 'succeeded' },
    )
    expect(() => session.recordToolResult(
      { eventId: 'second-result', occurredAt: 14 },
      { callId: 'call', content: 'again', status: 'succeeded' },
    )).toThrow('Tool result already recorded')
  })

  it('rejects legacy message/context snapshots instead of silently migrating them', () => {
    expect(() => SessionAggregate.restore({
      id: 'legacy',
      title: 'Legacy',
      messages: [],
      context: { messages: [] },
      createdAt: 1,
      updatedAt: 1,
    })).toThrow('Session bindings are invalid')
  })

  it('restores only a valid new-format snapshot and validates protocol pairing', () => {
    const snapshot = createSession().snapshot()
    const restored = SessionAggregate.restore(snapshot)
    expect(restored.snapshot()).toEqual(snapshot)

    expect(() => SessionAggregate.restore({
      ...snapshot,
      timeline: [{
        type: 'tool-execution-completed', eventId: 'result', occurredAt: 11,
        callId: 'missing', content: 'orphan', status: 'failed',
      }],
    })).toThrow('Session contains orphan tool result')
  })

  it('projects a context summary and omits the compacted events', () => {
    const session = createSession()
    session.acceptUserMessage(
      { eventId: 'old-user', occurredAt: 11 },
      { messageId: 'old-message', text: 'old turn' },
    )
    session.commitAssistantMessage(
      { eventId: 'old-assistant', occurredAt: 12 },
      { messageId: 'old-answer', display: 'old answer', source: 'text-fallback' },
    )
    session.compactContext(
      { eventId: 'compaction', occurredAt: 13 },
      { summary: 'The previous turn discussed an old topic.', summarizedEventIds: ['old-user', 'old-assistant'] },
    )
    session.acceptUserMessage(
      { eventId: 'new-user', occurredAt: 14 },
      { messageId: 'new-message', text: 'new turn' },
    )

    expect(session.projectModelContext()).toEqual([
      { role: 'system', content: 'The previous turn discussed an old topic.' },
      { role: 'user', content: 'new turn' },
    ])
    expect(session.projectTranscript()).toHaveLength(3)
  })

  it('records background display and voice completion as an explicit revision event', () => {
    const session = createSession()
    session.commitAssistantMessage(
      { eventId: 'commit', occurredAt: 11 },
      { messageId: 'answer', display: 'preview', voice: 'draft', source: 'text-fallback' },
    )
    session.reviseAssistantMessage(
      { eventId: 'revision', occurredAt: 12 },
      { messageId: 'answer', display: 'final', voice: 'spoken final' },
    )

    expect(session.projectTranscript()[0]).toMatchObject({ text: 'final', voice: 'spoken final' })
    expect(session.projectModelContext()).toEqual([{ role: 'assistant', content: 'final' }])
  })

  it('rejects a revision without an earlier committed assistant message', () => {
    const session = createSession()
    expect(() => session.reviseAssistantMessage(
      { eventId: 'revision', occurredAt: 11 },
      { messageId: 'missing', display: 'orphan' },
    )).toThrow('Unknown assistant message id')
  })

  it('rolls back timeline, checkpoints, and compacted context at one user-turn boundary', () => {
    const session = createSession()
    session.acceptUserMessage(
      { eventId: 'user-event-1', occurredAt: 11 },
      { messageId: 'user-1', text: 'first' },
    )
    session.addCheckpoint({
      id: 'checkpoint-1',
      userMessageId: 'user-1',
      createdAt: 11,
      hasWorkspaceChanges: false,
      character: null,
    }, 11)
    session.commitAssistantMessage(
      { eventId: 'assistant-event-1', occurredAt: 12 },
      { messageId: 'assistant-1', display: 'first answer', source: 'text-fallback' },
    )
    session.acceptUserMessage(
      { eventId: 'user-event-2', occurredAt: 13 },
      { messageId: 'user-2', text: 'second' },
    )
    session.addCheckpoint({
      id: 'checkpoint-2',
      userMessageId: 'user-2',
      createdAt: 13,
      hasWorkspaceChanges: true,
      character: {
        characterId: 'alice',
        emotion: 'happy',
        stance: 'idle',
        costume: 'default',
        screenPose: 'center',
      },
    }, 13)
    session.commitAssistantMessage(
      { eventId: 'assistant-event-2', occurredAt: 14 },
      { messageId: 'assistant-2', display: 'second answer', source: 'text-fallback' },
    )
    session.compactContext(
      { eventId: 'compaction', occurredAt: 15 },
      { summary: 'first and second turns', summarizedEventIds: ['user-event-1', 'assistant-event-1'] },
    )
    session.acceptUserMessage(
      { eventId: 'user-event-3', occurredAt: 16 },
      { messageId: 'user-3', text: 'third' },
    )
    session.addCheckpoint({
      id: 'checkpoint-3',
      userMessageId: 'user-3',
      createdAt: 16,
      hasWorkspaceChanges: true,
      character: null,
    }, 16)

    const result = session.rollbackToUserMessage('user-2', 20)

    expect(result.targetCheckpoint?.character).toMatchObject({ characterId: 'alice', emotion: 'happy' })
    expect(result.removedCheckpointIds).toEqual(['checkpoint-2', 'checkpoint-3'])
    expect(result.workspaceCheckpointIdsNewestFirst).toEqual(['checkpoint-3', 'checkpoint-2'])
    expect(session.projectTranscript().map(message => message.id)).toEqual(['user-1', 'assistant-1'])
    expect(session.projectModelContext()).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
    ])
    expect(session.snapshot()).toMatchObject({
      checkpoints: [{ id: 'checkpoint-1' }],
      contextState: { summary: null, summarizedEventIds: [] },
      updatedAt: 20,
    })
  })

  it('rejects checkpoint snapshots that do not belong to a user message', () => {
    const session = createSession()
    expect(() => session.addCheckpoint({
      id: 'orphan',
      userMessageId: 'missing',
      createdAt: 11,
      hasWorkspaceChanges: false,
      character: null,
    }, 11)).toThrow('Unknown checkpoint user message')
  })

  it('marks workspace changes and clears all conversation-owned state atomically', () => {
    const session = createSession()
    session.acceptUserMessage(
      { eventId: 'user-event', occurredAt: 11 },
      { messageId: 'user-1', text: 'change it' },
    )
    session.addCheckpoint({
      id: 'checkpoint-1',
      userMessageId: 'user-1',
      createdAt: 11,
      hasWorkspaceChanges: false,
      character: null,
    }, 11)

    session.markCheckpointWorkspaceChanges('checkpoint-1', 12)
    const result = session.clearConversation(13)

    expect(result.workspaceCheckpointIdsNewestFirst).toEqual(['checkpoint-1'])
    expect(session.snapshot()).toMatchObject({
      characterLocked: true,
      timeline: [],
      checkpoints: [],
      contextState: { summary: null, summarizedEventIds: [] },
      updatedAt: 13,
    })
    expect(() => session.bindCharacter('another-character', 14)).toThrow('Cannot change character')
  })
})
