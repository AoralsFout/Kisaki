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
    })).toThrow('Session timeline or checkpoints are invalid')
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
})
