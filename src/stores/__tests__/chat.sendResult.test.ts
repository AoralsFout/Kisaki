import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../ai', async original => ({
  ...await original<typeof import('../../ai')>(),
  loadConfig: () => ({ baseURL: 'http://localhost/v1', apiKey: 'test-only', model: 'test-model' }),
  chat: request,
}))
beforeEach(() => {
  setActivePinia(createPinia())
  request.mockReset()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())

describe('send result contract', () => {
  it('reports rejection without adding a message when offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    expect(await store.sendMessage('draft')).toBe(false)
    expect(store.messages).toHaveLength(0)
    expect(store.isProcessing).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('reports a request failure while retaining the accepted user turn for history', async () => {
    request.mockImplementation((_messages, callbacks) => callbacks.onError(new Error('connection failed')))
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    expect(await store.sendMessage('draft')).toBe(false)
    expect(store.messages.some(m => m.role === 'user' && m.text === 'draft')).toBe(true)
    expect(store.isProcessing).toBe(false)
  })

  it('reports a completed request so the caller can clear its draft', async () => {
    request.mockImplementation((_messages, callbacks) => callbacks.onDone(''))
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    expect(await store.sendMessage('draft')).toBe(true)
    expect(store.isProcessing).toBe(false)
  })
})
