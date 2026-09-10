import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionDocument } from '../../domain/conversation/events'

const { request, invokeMock } = vi.hoisted(() => ({
  request: vi.fn(),
  invokeMock: vi.fn(),
}))

vi.mock('../../ai', async original => ({
  ...await original<typeof import('../../ai')>(),
  loadConfig: () => ({ baseURL: 'http://localhost/v1', apiKey: 'test-only', model: 'test-model' }),
  chat: request,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { useChatStore } from '../chat'
import { useSessionStore } from '../session'

describe('ChatStore and SessionStore v2 integration', () => {
  let saved: SessionDocument | null

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    saved = null
    invokeMock.mockReset()
    invokeMock.mockImplementation((command: string, args?: { data?: string }) => {
      if (command === 'sessions_v2_load') return Promise.resolve(null)
      if (command === 'sessions_v2_save') {
        saved = JSON.parse(args?.data ?? '{}') as SessionDocument
      }
      return Promise.resolve()
    })
    request.mockReset()
  })

  it('commits user, tool protocol, result, and assistant reply to one timeline', async () => {
    request.mockImplementation((_messages, callbacks) => callbacks.onTools([{
      id: 'say-1',
      type: 'function',
      function: {
        name: 'say',
        arguments: JSON.stringify({ voice: 'hello', display: 'hello' }),
      },
    }]))
    const chat = useChatStore()
    const sessions = useSessionStore()
    await sessions.init()

    expect(await chat.sendMessage('hi')).toBe(true)

    expect(saved).not.toBeNull()
    const current = saved!.sessions.find(session => session.id === saved!.currentSessionId)!
    expect(current.timeline.map(event => event.type).slice(0, 4)).toEqual([
      'user-message-accepted',
      'assistant-tool-calls-produced',
      'tool-execution-completed',
      'assistant-message-committed',
    ])
    expect(current).not.toHaveProperty('messages')
    expect(current).not.toHaveProperty('context')
    expect(sessions.currentSession?.messages.map(message => message.text)).toEqual(['hi', 'hello'])
    expect(chat.messages.map(message => message.text)).toEqual(['hi', 'hello'])
  })
})
