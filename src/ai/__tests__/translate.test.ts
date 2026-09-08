import { beforeEach, describe, expect, it, vi } from 'vitest'

const quickChatMock = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ quickChat: quickChatMock }))

import { translateText } from '../translate'
import {
  clearBuffer,
  getBuffer,
  resetConfig,
  setLogLevel,
  setSensitiveDiagnosticsEnabled,
} from '../../utils/logger'

function sensitiveTranslateEvents() {
  return getBuffer().filter(entry => entry.event.startsWith('translate.') && entry.event.endsWith('_sensitive.debug'))
}

describe('translateText sensitive diagnostics', () => {
  beforeEach(() => {
    resetConfig()
    setLogLevel('trace')
    clearBuffer()
    localStorage.clear()
    quickChatMock.mockReset()
  })

  it('records the source and translated text when sensitive diagnostics is enabled', async () => {
    setSensitiveDiagnosticsEnabled(true)
    quickChatMock.mockResolvedValue('Hello, world')

    await translateText('你好，世界', 'en-US', { requestId: 'req-1', turn: 2 })

    const events = sensitiveTranslateEvents()
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual(expect.objectContaining({
      event: 'translate.request_sensitive.debug',
      context: expect.objectContaining({
        requestId: 'req-1',
        turn: 2,
        target_lang: 'en-US',
        source_text: '你好，世界',
      }),
    }))
    expect(events[1]).toEqual(expect.objectContaining({
      event: 'translate.result_sensitive.debug',
      context: expect.objectContaining({
        source_text: '你好，世界',
        translated_text: 'Hello, world',
      }),
    }))
  })

  it('does not record translation text when sensitive diagnostics is disabled', async () => {
    setSensitiveDiagnosticsEnabled(false)
    quickChatMock.mockResolvedValue('Hello')

    await translateText('另一段文本', 'en-US')

    expect(sensitiveTranslateEvents()).toEqual([])
  })
})
