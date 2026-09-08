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

  it('reports an empty model response as failed', async () => {
    request.mockImplementation((_messages, callbacks) => callbacks.onDone(''))
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    expect(await store.sendMessage('draft')).toBe(false)
    expect(store.messages.filter(m => m.role === 'assistant')).toHaveLength(0)
    expect(store.isProcessing).toBe(false)
  })

  it('reports a delivered say response as completed', async () => {
    request.mockImplementation((_messages, callbacks) => callbacks.onTools([{
      id: 'say-1',
      type: 'function',
      function: {
        name: 'say',
        arguments: JSON.stringify({ voice: 'こんにちは', display: '你好' }),
      },
    }]))
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    expect(await store.sendMessage('draft')).toBe(true)
    expect(store.messages.some(m => m.role === 'assistant' && m.text === '你好')).toBe(true)
    expect(store.isProcessing).toBe(false)
  })

  it('renders visible streamed text immediately and hides think content', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    const snapshots: string[] = []
    request.mockImplementation((_messages, callbacks) => {
      callbacks.onChunk('<think>分析中')
      snapshots.push(store.currentBubbleText)
      callbacks.onChunk('</think>你')
      snapshots.push(store.currentBubbleText)
      callbacks.onChunk('好')
      snapshots.push(store.currentBubbleText)
      callbacks.onTools([{
        id: 'say-stream-1',
        type: 'function',
        function: {
          name: 'say',
          arguments: JSON.stringify({ voice: '你好', display: '你好' }),
        },
      }])
    })

    expect(await store.sendMessage('draft')).toBe(true)
    expect(snapshots).toEqual(['', '你', '你好'])
    expect(store.currentBubbleText).toBe('你好')
    expect(store.isProcessing).toBe(false)
  })

  it('renders streamed say arguments before the tool call completes', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    const snapshots: string[] = []
    request.mockImplementation((_messages, callbacks) => {
      callbacks.onToolCallDelta?.([{
        id: 'say-stream-args-1',
        type: 'function',
        function: { name: 'say', arguments: '{"voice":"こんにちは","display":"你' },
      }])
      snapshots.push(store.currentBubbleText)
      callbacks.onToolCallDelta?.([{
        id: 'say-stream-args-1',
        type: 'function',
        function: { name: 'say', arguments: '{"voice":"こんにちは","display":"你好"}' },
      }])
      snapshots.push(store.currentBubbleText)
      callbacks.onTools([{
        id: 'say-stream-args-1',
        type: 'function',
        function: { name: 'say', arguments: '{"voice":"こんにちは","display":"你好"}' },
      }])
    })

    expect(await store.sendMessage('draft')).toBe(true)
    expect(snapshots).toEqual(['你', '你好'])
    expect(store.currentBubbleText).toBe('你好')
  })
})
