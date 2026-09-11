import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectAudioSink, type AudioSink } from '../../application/tts/audioSink'
import type { BufferedAudioSource } from '../../application/tts/ttsProvider'
import { HtmlAudioSink } from './htmlAudioSink'
import { Live2DLipSyncSink } from './live2DLipSyncSink'

class FakeAudio {
  static instances: FakeAudio[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = false
  src: string
  play = vi.fn(() => Promise.resolve())

  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }

  pause() {
    this.paused = true
  }
}

function source(): BufferedAudioSource {
  return { kind: 'buffered', blob: new Blob(['audio'], { type: 'audio/mpeg' }), mimeType: 'audio/mpeg' }
}

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('HtmlAudioSink', () => {
  it('plays a buffered source, reports first audio, and cleans up on end', async () => {
    const onFirstAudio = vi.fn()
    const playback = new HtmlAudioSink().play(source(), {
      signal: new AbortController().signal,
      onFirstAudio,
    })

    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
    FakeAudio.instances[0].onended?.()
    await expect(playback).resolves.toBeUndefined()

    expect(onFirstAudio).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })

  it('stops playback when the signal aborts', async () => {
    const controller = new AbortController()
    const playback = new HtmlAudioSink().play(source(), { signal: controller.signal })

    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
    controller.abort()

    await expect(playback).resolves.toBeUndefined()
    expect(FakeAudio.instances[0].paused).toBe(true)
  })

  it('reports playback failure instead of resolving silently', async () => {
    const playback = new HtmlAudioSink().play(source(), { signal: new AbortController().signal })

    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
    FakeAudio.instances[0].onerror?.()

    await expect(playback).rejects.toThrow('音频播放失败')
  })
})

describe('Live2DLipSyncSink', () => {
  it('is not selectable without an attached voice player', () => {
    const htmlAudio = new HtmlAudioSink()
    const sinks: AudioSink[] = [new Live2DLipSyncSink(() => null, htmlAudio), htmlAudio]

    expect(selectAudioSink(sinks, source()).id).toBe('html-audio')
  })

  it('drives lip sync when a voice player is attached', async () => {
    const onFirstAudio = vi.fn()
    const voicePlayer = vi.fn().mockResolvedValue(undefined)
    const lipSync = new Live2DLipSyncSink(() => voicePlayer, new HtmlAudioSink())

    await lipSync.play(source(), { signal: new AbortController().signal, onFirstAudio })

    expect(voicePlayer).toHaveBeenCalledWith('blob:test', expect.any(AbortSignal))
    expect(onFirstAudio).toHaveBeenCalledOnce()
  })

  it('falls back to the default sink when lip sync fails', async () => {
    const fallback = { id: 'fallback', canPlay: () => true, play: vi.fn().mockResolvedValue(undefined) }
    const lipSync = new Live2DLipSyncSink(
      () => vi.fn().mockRejectedValue(new Error('playVoice failed')),
      fallback,
    )

    await lipSync.play(source(), { signal: new AbortController().signal })

    expect(fallback.play).toHaveBeenCalledOnce()
  })

  it('does not fall back after cancellation', async () => {
    const controller = new AbortController()
    const fallback = { id: 'fallback', canPlay: () => true, play: vi.fn() }
    const lipSync = new Live2DLipSyncSink(
      () => () => {
        controller.abort()
        return Promise.reject(new Error('aborted'))
      },
      fallback,
    )

    await lipSync.play(source(), { signal: controller.signal })

    expect(fallback.play).not.toHaveBeenCalled()
  })
})
