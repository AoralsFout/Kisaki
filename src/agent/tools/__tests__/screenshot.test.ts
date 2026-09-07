import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, hideMock, showMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  hideMock: vi.fn(),
  showMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ hide: hideMock, show: showMock }),
}))

import { captureScreenTool } from '../screenshot'

const result = {
  data_url: 'data:image/png;base64,cG5n',
  mime_type: 'image/png',
  size: 3,
  name: 'screen-capture.png',
  width: 1920,
  height: 1080,
  monitor_name: 'Display 1',
}

describe('captureScreenTool', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(result)
    hideMock.mockReset().mockResolvedValue(undefined)
    showMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => vi.useRealTimers())

  it('returns an in-memory image without hiding Kisaki when explicitly included', async () => {
    const output = await captureScreenTool.handler({
      target: 'primary_monitor',
      include_kisaki: true,
    })

    expect(hideMock).not.toHaveBeenCalled()
    expect(showMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('agent_capture_screen', { target: 'primary_monitor' })
    expect(output).not.toBeTypeOf('string')
    if (typeof output !== 'string') {
      expect(output.images).toEqual([expect.objectContaining({
        mimeType: 'image/png',
        dataUrl: result.data_url,
        size: 3,
      })])
    }
  })

  it('hides Kisaki by default and always restores it after capture', async () => {
    vi.useFakeTimers()
    const pending = captureScreenTool.handler({})
    await vi.advanceTimersByTimeAsync(160)
    await pending

    expect(hideMock).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith('agent_capture_screen', { target: 'cursor_monitor' })
    expect(showMock).toHaveBeenCalledOnce()
  })

  it('restores Kisaki when native capture fails', async () => {
    vi.useFakeTimers()
    invokeMock.mockRejectedValueOnce(new Error('capture failed'))
    const pending = captureScreenTool.handler({})
    const expectation = expect(pending).rejects.toThrow('capture failed')
    await vi.advanceTimersByTimeAsync(160)
    await expectation

    expect(showMock).toHaveBeenCalledOnce()
  })
})
