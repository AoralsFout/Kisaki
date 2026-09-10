import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const request = vi.hoisted(() => vi.fn())
const translate = vi.hoisted(() => vi.fn())
vi.mock('../../ai', async original => ({
  ...await original<typeof import('../../ai')>(),
  loadConfig: () => ({ baseURL: 'http://localhost/v1', apiKey: 'test-only', model: 'test-model' }),
  chat: request,
  translateText: translate,
}))
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  request.mockReset()
  translate.mockReset()
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
    expect(store.currentBubbleText).toContain('connection failed')
    expect(store.conversationRunState).toBe('failed')
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
    expect(store.conversationRunState).toBe('completed')
  })

  it('renders visible streamed text immediately and hides think content', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    const snapshots: string[] = []
    request.mockImplementation((_messages, callbacks) => {
      callbacks.onChunk('<thi')
      snapshots.push(store.currentBubbleText)
      callbacks.onChunk('nk>分析中')
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
    expect(snapshots).toEqual(['', '', '你', '你好'])
    expect(store.currentBubbleText).toBe('你好')
    expect(store.isProcessing).toBe(false)
  })

  it('每个工具轮次都重新隐藏 think 内容', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    const secondTurnSnapshots: string[] = []
    let turn = 0
    request.mockImplementation((_messages, callbacks) => {
      if (turn++ === 0) {
        callbacks.onChunk('<think>第一轮分析</think>')
        callbacks.onTools([{
          id: 'calc-1',
          type: 'function',
          function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
        }])
        return
      }

      callbacks.onChunk('<thi')
      secondTurnSnapshots.push(store.currentBubbleText)
      callbacks.onChunk('nk>第二轮分析')
      secondTurnSnapshots.push(store.currentBubbleText)
      callbacks.onChunk('</think>')
      secondTurnSnapshots.push(store.currentBubbleText)
      callbacks.onTools([{
        id: 'say-after-tool',
        type: 'function',
        function: { name: 'say', arguments: '{"voice":"完成","display":"完成"}' },
      }])
    })

    expect(await store.sendMessage('draft')).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    expect(secondTurnSnapshots).toEqual(['', '', ''])
    expect(store.currentBubbleText).toBe('完成')
    expect(store.currentThinking).toBe('第二轮分析')
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

  it('unlocks input after display is delivered without waiting for voice preparation', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    let finishTranslation!: (value: string) => void
    translate.mockImplementation(() => new Promise<string>((resolve) => {
      finishTranslation = resolve
    }))
    request.mockImplementation((_messages, callbacks) => callbacks.onTools([{
      id: 'say-voice-later',
      type: 'function',
      function: {
        name: 'say',
        arguments: JSON.stringify({ display: '你好' }),
      },
    }]))

    expect(await store.sendMessage('draft')).toBe(true)
    expect(store.isProcessing).toBe(false)
    expect(store.currentBubbleText).toBe('你好')
    expect(translate).toHaveBeenCalled()

    finishTranslation('こんにちは')
    await vi.waitFor(() => {
      expect(store.messages.find(message => message.role === 'assistant')?.voice).toBe('こんにちは')
    })
  })

  it('清空消息会取消仍在准备中的后台语音', async () => {
    const { useChatStore } = await import('../chat')
    const { clearBuffer, getBuffer } = await import('../../utils/logger')
    const store = useChatStore()
    clearBuffer()
    let finishTranslation!: (value: string) => void
    let translationSignal: AbortSignal | undefined
    translate.mockImplementation((_text, _target, options) => {
      translationSignal = options?.signal
      return new Promise<string>((resolve) => { finishTranslation = resolve })
    })
    request.mockImplementation((_messages, callbacks) => callbacks.onTools([{
      id: 'say-cleared-before-voice',
      type: 'function',
      function: {
        name: 'say',
        arguments: JSON.stringify({ display: '稍后清空' }),
      },
    }]))

    expect(await store.sendMessage('draft')).toBe(true)
    expect(translationSignal?.aborted).toBe(false)
    store.clearMessages()
    expect(translationSignal?.aborted).toBe(true)

    finishTranslation('あとで消去')
    await Promise.resolve()
    await Promise.resolve()
    expect(store.messages).toHaveLength(0)
    expect(store.currentBubbleText).toBe('')
    await vi.waitFor(() => {
      expect(getBuffer().some(entry => (
        entry.event === 'tts.playback_completed'
        && entry.context?.status === 'cancelled'
        && entry.context?.reason === 'voice_preparation_cancelled'
      ))).toBe(true)
    })
  })

  it('等待文件操作确认时取消会解除等待并清理所有运行态', async () => {
    const { useChatStore, setChatSessionPort } = await import('../chat')
    setChatSessionPort({
      currentSessionId: () => 'session-1',
      workspaceGrantId: () => 'workspace-1',
      acceptUserMessage: async () => true,
      recordToolCalls: async () => true,
      recordToolResult: async () => true,
      commitAssistantMessage: async () => 'assistant-1',
      reviseAssistantMessage: async () => true,
      beginCheckpoint: async () => 'checkpoint-1',
      backupFile: async () => {},
      markCheckpointFiles: async () => {},
      clearConversation: async () => {},
    })
    const store = useChatStore()
    let modelTurn = 0
    request.mockImplementation((_messages, callbacks, signal: AbortSignal) => {
      if (modelTurn++ === 0) {
        callbacks.onTools([{
          id: 'write-awaiting-confirmation',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'notes.txt', content: 'pending' }),
          },
        }])
        return
      }
      const error = new Error('cancelled')
      error.name = signal.aborted ? 'AbortError' : 'UnexpectedError'
      callbacks.onError(error)
    })

    const sending = store.sendMessage('write a note')
    await vi.waitFor(() => {
      expect(store.pendingApproval?.id).toBe('write-awaiting-confirmation')
    })
    expect(store.conversationRunState).toBe('awaiting-approval')

    store.cancelResponse()
    await sending

    expect(store.pendingApproval).toBeNull()
    expect(store.isProcessing).toBe(false)
    expect(store.isUsingTools).toBe(false)
    expect(store.conversationRunState).toBe('cancelled')
    expect(store.currentBubbleText).toBe('')
    setChatSessionPort(null)
  })
})
