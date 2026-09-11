import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatMock, loadConfigMock, isConfigValidMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  loadConfigMock: vi.fn(),
  isConfigValidMock: vi.fn(),
}))

// 整个 AI 模块被替换掉：这个适配器的契约就是「回调 → Promise」，
// 真机请求策略属于 ai.chat 自己的测试面。
vi.mock('../../ai/client', () => ({
  chat: chatMock,
  loadConfig: loadConfigMock,
  isConfigValid: isConfigValidMock,
}))

import type { StreamCallbacks } from '../../ai/types'
import { AiModelClient } from './aiModelClient'
import type { ConversationModelRequest } from '../../application/conversation/conversationSession'

function request(overrides: Partial<ConversationModelRequest> = {}): ConversationModelRequest {
  return {
    requestId: 'request-1',
    turn: 0,
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    signal: new AbortController().signal,
    onChunk: () => {},
    onThinking: () => {},
    onToolCallDelta: () => {},
    ...overrides,
  }
}

/** 让 chat() 桩在一次调用里吐出给定的回调序列。 */
function emit(behaviour: (callbacks: StreamCallbacks) => void): void {
  chatMock.mockImplementation((_messages: unknown, callbacks: StreamCallbacks) => {
    behaviour(callbacks)
    return Promise.resolve()
  })
}

describe('AiModelClient', () => {
  beforeEach(() => {
    chatMock.mockReset()
    loadConfigMock.mockReset()
    isConfigValidMock.mockReset()
    emit(() => {})
  })

  it('reports readiness and model from the configuration loader', () => {
    loadConfigMock.mockReturnValue({ baseURL: 'https://example.test/v1', apiKey: 'k', model: 'gpt-4o-mini' })
    isConfigValidMock.mockReturnValue(true)

    expect(new AiModelClient().configuration()).toEqual({ ready: true, model: 'gpt-4o-mini' })
  })

  it('reports an empty model when the configuration has none', () => {
    loadConfigMock.mockReturnValue({ baseURL: '', apiKey: '', model: '' })
    isConfigValidMock.mockReturnValue(false)

    expect(new AiModelClient().configuration()).toEqual({ ready: false, model: '' })
  })

  it('turns onTools into a tools turn', async () => {
    const calls = [{ id: 'call-1', type: 'function' as const, function: { name: 'say', arguments: '{}' } }]
    emit(callbacks => callbacks.onTools?.(calls, '前置正文'))

    await expect(new AiModelClient().call(request())).resolves.toEqual({
      type: 'tools',
      calls,
      text: '前置正文',
    })
  })

  it('turns onDone into a done turn', async () => {
    emit(callbacks => callbacks.onDone('最终正文'))

    await expect(new AiModelClient().call(request())).resolves.toEqual({ type: 'done', text: '最终正文' })
  })

  it('rejects when the module reports an error', async () => {
    const failure = new Error('API Key 无效或已过期')
    emit(callbacks => callbacks.onError(failure))

    await expect(new AiModelClient().call(request())).rejects.toBe(failure)
  })

  it('rejects instead of hanging when chat() itself rejects', async () => {
    chatMock.mockImplementation(() => Promise.reject(new Error('密钥链不可用')))

    await expect(new AiModelClient().call(request())).rejects.toThrow('密钥链不可用')
  })

  it('forwards stream deltas, the abort signal, tools and telemetry', async () => {
    const onChunk = vi.fn()
    const onThinking = vi.fn()
    const onToolCallDelta = vi.fn()
    const signal = new AbortController().signal
    const tools = [{ type: 'function' as const, function: { name: 'say', description: '', parameters: {} } }]
    const deltas = [{ id: 'call-1', type: 'function' as const, function: { name: 'say', arguments: '{"voice"' } }]
    emit(callbacks => {
      callbacks.onChunk('正文')
      callbacks.onThinking?.('思考')
      callbacks.onToolCallDelta?.(deltas)
      callbacks.onDone('正文')
    })

    await new AiModelClient().call(request({ onChunk, onThinking, onToolCallDelta, signal, tools }))

    expect(onChunk).toHaveBeenCalledWith('正文')
    expect(onThinking).toHaveBeenCalledWith('思考')
    expect(onToolCallDelta).toHaveBeenCalledWith(deltas)
    expect(chatMock).toHaveBeenCalledWith(
      [{ role: 'user', content: '你好' }],
      expect.anything(),
      signal,
      tools,
      undefined,
      { requestId: 'request-1', turn: 0 },
    )
  })
})
