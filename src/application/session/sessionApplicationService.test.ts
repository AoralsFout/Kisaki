import { describe, expect, it, vi } from 'vitest'
import type { SessionDocument } from '../../domain/conversation/events'
import type { SessionRepository } from './sessionRepository'
import { SessionApplicationService } from './sessionApplicationService'

class MemorySessionRepository implements SessionRepository {
  document: SessionDocument | null = null
  save = vi.fn(async (document: SessionDocument) => {
    this.document = structuredClone(document)
  })

  async load(): Promise<SessionDocument | null> {
    return this.document && structuredClone(this.document)
  }
}

function setup() {
  const repository = new MemorySessionRepository()
  let now = 10
  let id = 0
  const service = new SessionApplicationService({
    repository,
    now: () => now++,
    nextId: () => `session-${++id}`,
  })
  return { repository, service }
}

describe('SessionApplicationService', () => {
  it('creates and persists the first v2 session when storage is empty', async () => {
    const { repository, service } = setup()

    const result = await service.initialize('New conversation')

    expect(result.schemaVersion).toBe(2)
    expect(result.currentSessionId).toBe('session-1')
    expect(repository.save).toHaveBeenCalledOnce()
  })

  it('coordinates create, switch, rename, and delete through one owner', async () => {
    const { repository, service } = setup()
    await service.initialize('First')
    const second = await service.create({ title: 'Second', characterId: 'alice' })
    await service.rename('session-1', 'Renamed')
    await service.switchTo('session-1')
    const current = await service.delete('session-1')

    expect(second.characterId).toBe('alice')
    expect(current.id).toBe('session-2')
    expect(service.snapshot().sessions.map(session => session.title)).toEqual(['Second'])
    expect(repository.save).toHaveBeenCalledTimes(5)
  })

  it('restores an existing strict document without rewriting it', async () => {
    const { repository, service } = setup()
    await service.initialize('First')
    repository.save.mockClear()

    const restored = new SessionApplicationService({
      repository,
      now: () => 99,
      nextId: () => 'unused',
    })

    await restored.initialize('Ignored')

    expect(restored.current().title).toBe('First')
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects commands before initialization', async () => {
    const { service } = setup()

    expect(() => service.snapshot()).toThrow('not initialized')
    await expect(service.create({ title: 'Too early' })).rejects.toThrow('not initialized')
  })

  it('rolls back the in-memory command when persistence fails', async () => {
    const { repository, service } = setup()
    await service.initialize('First')
    repository.save.mockRejectedValueOnce(new Error('disk full'))

    await expect(service.create({ title: 'Unsaved' })).rejects.toThrow('disk full')

    expect(service.snapshot().sessions.map(session => session.title)).toEqual(['First'])
    expect(service.snapshot().currentSessionId).toBe('session-1')
  })

  it('records conversation facts through explicit application commands', async () => {
    const { service } = setup()
    await service.initialize('First')

    await service.acceptUserMessage('session-1', { messageId: 'user-1', text: 'hello' })
    await service.recordToolCalls('session-1', {
      stepId: 'step-1',
      calls: [{ id: 'say-1', name: 'say', arguments: { display: 'hi' } }],
    })
    await service.recordToolResult('session-1', {
      callId: 'say-1', content: 'spoken', status: 'succeeded',
    })
    await service.commitAssistantMessage('session-1', {
      messageId: 'answer-1', display: 'hi', source: 'say',
    })
    await service.reviseAssistantMessage('session-1', {
      messageId: 'answer-1', voice: 'hello',
    })

    expect(service.current().timeline.map(event => event.type)).toEqual([
      'user-message-accepted',
      'assistant-tool-calls-produced',
      'tool-execution-completed',
      'assistant-message-committed',
      'assistant-message-revised',
    ])
  })

  it('实时压缩只需提交摘要，服务按当前用户边界记录被吸收事件', async () => {
    const { service } = setup()
    await service.initialize('First')
    await service.acceptUserMessage('session-1', { messageId: 'user-1', text: 'first' })
    await service.recordToolCalls('session-1', {
      stepId: 'step-1',
      calls: [{ id: 'call-1', name: 'read_file', arguments: {} }],
    })
    await service.recordToolResult('session-1', {
      callId: 'call-1', content: 'done', status: 'succeeded',
    })
    await service.commitAssistantMessage('session-1', {
      messageId: 'assistant-1', display: 'answer', source: 'text-fallback',
    })
    await service.acceptUserMessage('session-1', { messageId: 'user-2', text: 'second' })

    await service.compactContext('session-1', { summary: 'first turn summary', summarizedRounds: 1 })

    const current = service.current()
    const compaction = current.timeline.find(event => event.type === 'context-compacted')
    const currentUserIndex = current.timeline.findIndex(event => (
      event.type === 'user-message-accepted' && event.messageId === 'user-2'
    ))
    expect(compaction).toMatchObject({
      summary: 'first turn summary',
      summarizedEventIds: current.timeline
        .slice(0, currentUserIndex)
        .filter(event => event.type !== 'context-compacted')
        .map(event => event.eventId),
    })
  })

  it('多次实时压缩按累计回合映射完整事实，且不会把旧摘要事件再次纳入', async () => {
    const { service } = setup()
    await service.initialize('First')
    await service.acceptUserMessage('session-1', { messageId: 'user-1', text: 'first' })
    await service.recordToolCalls('session-1', {
      stepId: 'step-1', calls: [{ id: 'call-1', name: 'read_file', arguments: {} }],
    })
    await service.recordToolResult('session-1', {
      callId: 'call-1', content: 'one', status: 'succeeded',
    })
    await service.commitAssistantMessage('session-1', {
      messageId: 'assistant-1', display: 'answer one', source: 'text-fallback',
    })
    await service.acceptUserMessage('session-1', { messageId: 'user-2', text: 'second' })

    await service.compactContext('session-1', { summary: 'summary one', summarizedRounds: 1 })
    const firstCompaction = service.current().timeline.find(event => event.type === 'context-compacted')
    expect(firstCompaction?.summarizedEventIds).toEqual(
      service.current().timeline
        .slice(0, 4)
        .map(event => event.eventId),
    )

    await service.recordToolCalls('session-1', {
      stepId: 'step-2', calls: [{ id: 'call-2', name: 'read_file', arguments: {} }],
    })
    await service.recordToolResult('session-1', {
      callId: 'call-2', content: 'two', status: 'succeeded',
    })
    await service.commitAssistantMessage('session-1', {
      messageId: 'assistant-2', display: 'answer two', source: 'text-fallback',
    })
    await service.acceptUserMessage('session-1', { messageId: 'user-3', text: 'third' })

    await service.compactContext('session-1', { summary: 'summary one\nsummary two', summarizedRounds: 2 })
    const timeline = service.current().timeline
    const secondCompaction = [...timeline].reverse().find(event => event.type === 'context-compacted')
    const secondUserIndex = timeline.findIndex(event => (
      event.type === 'user-message-accepted' && event.messageId === 'user-3'
    ))
    const expected = timeline
      .slice(0, secondUserIndex)
      .filter(event => event.type !== 'context-compacted')
      .map(event => event.eventId)

    expect(secondCompaction?.summarizedEventIds).toEqual(expected)
    expect(new Set(secondCompaction?.summarizedEventIds).size).toBe(expected.length)
    expect(secondCompaction?.summarizedEventIds).not.toContain(firstCompaction?.eventId)
  })

  it('serializes overlapping commands so an older save cannot win the race', async () => {
    const { repository, service } = setup()
    await service.initialize('First')
    repository.save.mockClear()
    let releaseCreate!: () => void
    const createBlocked = new Promise<void>(resolve => { releaseCreate = resolve })
    repository.save
      .mockImplementationOnce(async document => {
        await createBlocked
        repository.document = structuredClone(document)
      })
      .mockImplementationOnce(async document => {
        repository.document = structuredClone(document)
      })

    const creating = service.create({ title: 'Second' })
    const renaming = service.rename('session-1', 'Renamed')
    await Promise.resolve()
    expect(repository.save).toHaveBeenCalledTimes(1)

    releaseCreate()
    await Promise.all([creating, renaming])

    expect(repository.document?.sessions.map(session => session.title)).toEqual(['Renamed', 'Second'])
  })

  it('persists rollback as one command and returns its external recovery plan', async () => {
    const { repository, service } = setup()
    await service.initialize('First')
    await service.acceptUserMessage('session-1', { messageId: 'user-1', text: 'first' })
    await service.addCheckpoint('session-1', {
      id: 'checkpoint-1',
      userMessageId: 'user-1',
      createdAt: 12,
      hasWorkspaceChanges: true,
      character: null,
    })
    await service.commitAssistantMessage('session-1', {
      messageId: 'assistant-1', display: 'answer', source: 'text-fallback',
    })

    const result = await service.rollbackToUserMessage('session-1', 'user-1')

    expect(result).toEqual({
      targetCheckpoint: {
        id: 'checkpoint-1',
        userMessageId: 'user-1',
        createdAt: 12,
        hasWorkspaceChanges: true,
        character: null,
      },
      removedCheckpointIds: ['checkpoint-1'],
      workspaceCheckpointIdsNewestFirst: ['checkpoint-1'],
    })
    expect(service.current().timeline).toEqual([])
    expect(repository.document?.sessions[0].timeline).toEqual([])
  })

  it('restores the aggregate when rollback persistence fails', async () => {
    const { repository, service } = setup()
    await service.initialize('First')
    await service.acceptUserMessage('session-1', { messageId: 'user-1', text: 'keep me' })
    repository.save.mockRejectedValueOnce(new Error('disk full'))

    await expect(service.rollbackToUserMessage('session-1', 'user-1')).rejects.toThrow('disk full')

    expect(service.current().timeline).toHaveLength(1)
    expect(service.current().timeline[0]).toMatchObject({ messageId: 'user-1' })
  })
})
