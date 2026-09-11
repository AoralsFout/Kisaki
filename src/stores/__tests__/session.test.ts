import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionDocument } from '../../domain/conversation/events'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import { composeApplication } from '../../compositionRoot'
import { useChatStore } from '../chat'
import { useSessionStore } from '../session'

function document(): SessionDocument {
  return {
    schemaVersion: 2,
    currentSessionId: 'session-1',
    sessions: [{
      id: 'session-1',
      title: 'Saved session',
      characterId: 'alice',
      characterLocked: false,
      character: null,
      workspaceGrantId: null,
      timeline: [],
      checkpoints: [],
      contextState: { summary: null, summarizedEventIds: [] },
      createdAt: 1,
      updatedAt: 1,
    }],
  }
}

function useTauriDocument(saved: SessionDocument | null = null): { saves: SessionDocument[] } {
  const saves: SessionDocument[] = []
  invokeMock.mockImplementation((command: string, args?: { data?: string; workspaceId?: string }) => {
    if (command === 'sessions_v2_load') return Promise.resolve(saved ? JSON.stringify(saved) : null)
    if (command === 'sessions_v2_save') {
      saves.push(JSON.parse(args?.data ?? '{}') as SessionDocument)
      return Promise.resolve()
    }
    if (command === 'agent_resolve_workspace') return Promise.resolve(`C:\\workspace\\${args?.workspaceId}`)
    return Promise.resolve()
  })
  return { saves }
}

describe('SessionStore v2 projection facade', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    localStorage.clear()
    // 真机 / 内存仓储的选择与 SessionApplicationService 的构造都在组合根；
    // store 只消费装配结果，因此测试也必须经组合根装配。
    await composeApplication()
  })

  it('creates and persists only a strict v2 document on first launch', async () => {
    const { saves } = useTauriDocument()
    const store = useSessionStore()

    await store.init()

    expect(store.ready).toBe(true)
    expect(store.sessionList).toHaveLength(1)
    expect(store.currentSession?.name).toBe('新对话')
    expect(store.currentSession?.messages).toEqual([])
    expect(saves[0]).toMatchObject({ schemaVersion: 2 })
    expect(invokeMock).not.toHaveBeenCalledWith('sessions_load', expect.anything())
    expect(localStorage.length).toBe(0)
  })

  it('projects one timeline into UI history and protocol context', async () => {
    const saved = document()
    saved.sessions[0].timeline = [
      {
        type: 'user-message-accepted', eventId: 'event-user', occurredAt: 2,
        messageId: 'user-1', text: 'read it', images: [],
      },
      {
        type: 'assistant-tool-calls-produced', eventId: 'event-calls', occurredAt: 3,
        stepId: 'step-1', calls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } }],
      },
      {
        type: 'tool-execution-completed', eventId: 'event-result', occurredAt: 4,
        callId: 'call-1', content: 'contents', status: 'succeeded',
      },
      {
        type: 'assistant-message-committed', eventId: 'event-answer', occurredAt: 5,
        messageId: 'assistant-1', display: 'done', voice: 'done', source: 'say',
      },
    ]
    saved.sessions[0].characterLocked = true
    saved.sessions[0].updatedAt = 5
    useTauriDocument(saved)

    const store = useSessionStore()
    await store.init()

    expect(store.currentSession?.messages.map(message => message.text)).toEqual(['read it', 'done'])
    expect(useChatStore().messages.map(message => message.id)).toEqual(['user-1', 'assistant-1'])
    expect(useChatStore().exportContext().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call-1' })] }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: 'contents' }),
    ]))
    expect(store.canChangeCharacter).toBe(false)
  })

  it('coordinates create, rename, switch, and delete through the application service', async () => {
    useTauriDocument()
    const store = useSessionStore()
    await store.init()
    const firstId = store.currentSessionId

    const second = await store.createSession('Work')
    expect(store.currentSessionId).toBe(second.id)
    expect(await store.renameSession(second.id, 'Renamed')).toBe(true)
    expect(store.currentSession?.name).toBe('Renamed')
    expect(await store.switchSession(firstId)).toBe(true)
    expect(await store.deleteSession(second.id)).toBe(true)
    expect(store.sessionList.map(session => session.name)).toEqual(['新对话'])
    expect(await store.deleteSession(firstId)).toBe(false)
  })

  it('keeps workspace paths as runtime projections of persisted grants', async () => {
    const saved = document()
    saved.sessions[0].workspaceGrantId = 'grant-1'
    useTauriDocument(saved)
    const store = useSessionStore()

    await store.init()

    expect(store.currentSession).toMatchObject({
      workspaceId: 'grant-1',
      workspaceRoot: 'C:\\workspace\\grant-1',
    })
    await store.setWorkspace({ id: 'grant-2', path: 'D:\\project' })
    expect(store.currentSession).toMatchObject({ workspaceId: 'grant-2', workspaceRoot: 'D:\\project' })
    await store.clearWorkspace()
    expect(store.currentSession).toMatchObject({ workspaceId: null, workspaceRoot: null })
  })

  it('rolls back through the aggregate and then executes its file recovery plan', async () => {
    const saved = document()
    saved.sessions[0].timeline = [{
      type: 'user-message-accepted', eventId: 'event-user', occurredAt: 2,
      messageId: 'user-1', text: 'change file', images: [],
    }]
    saved.sessions[0].characterLocked = true
    saved.sessions[0].checkpoints = [{
      id: 'user-1',
      userMessageId: 'user-1',
      createdAt: 2,
      hasWorkspaceChanges: true,
      character: null,
    }]
    useTauriDocument(saved)
    const store = useSessionStore()
    await store.init()

    expect(await store.rollbackTo('user-1')).toBe(true)

    expect(store.currentSession?.messages).toEqual([])
    expect(useChatStore().messages).toEqual([])
    expect(invokeMock).toHaveBeenCalledWith('agent_checkpoint_rollback', {
      sessionId: 'session-1',
      checkpointIds: ['user-1'],
    })
  })

  it('does not parse or overwrite a legacy document', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'sessions_v2_load') {
        return Promise.resolve(JSON.stringify({ sessions: [], currentId: '' }))
      }
      return Promise.resolve()
    })
    const store = useSessionStore()

    await store.init()

    expect(store.persistError).toBe(true)
    expect(store.sessionList).toHaveLength(1)
    expect(invokeMock).not.toHaveBeenCalledWith('sessions_v2_save', expect.anything())
  })
})
