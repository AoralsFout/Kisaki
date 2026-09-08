import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveSecretMock = vi.hoisted(() => vi.fn())
vi.mock('../../utils/secretStore', () => ({
  persistSecret: vi.fn(),
  resolveSecret: resolveSecretMock,
  keychainDelete: vi.fn(),
}))

import { chat, saveConfig } from '../client'

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
}

describe('chat stream tool call deltas', () => {
  beforeEach(() => {
    localStorage.clear()
    resolveSecretMock.mockReset()
    resolveSecretMock.mockResolvedValue({ key: 'test-key', needsResave: false, storage: 'local' })
    saveConfig({ baseURL: 'http://localhost/v1', apiKey: 'test-key', model: 'test-model' })
  })

  it('emits accumulated tool call snapshots while say arguments are streaming', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"say","arguments":"{\\"voice\\":\\"こんにちは\\",\\"display\\":\\"你"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"好\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    const snapshots: string[] = []
    await new Promise<void>((resolve, reject) => {
      void chat([{ role: 'user', content: 'hi' }], {
        onChunk: () => {},
        onToolCallDelta: (calls) => snapshots.push(calls[0]?.function.arguments ?? ''),
        onTools: () => resolve(),
        onDone: () => reject(new Error('unexpected onDone')),
        onError: reject,
      })
    })

    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toContain('"display":"你')
    expect(snapshots[1]).toContain('"display":"你好"')
    vi.unstubAllGlobals()
  })
})
