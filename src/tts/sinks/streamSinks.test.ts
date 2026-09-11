import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAudioSink, type AudioSink } from '../../application/tts/audioSink'
import type { BufferedAudioSource, StreamedAudioSource } from '../../application/tts/ttsProvider'
import { TtsEngine } from '../speak'
import { setTtsProvider } from '../config'
import type { TtsProvider } from '../../application/tts/ttsProvider'
import { MediaSourceStreamSink } from './mediaSourceStreamSink'
import { PcmStreamSink } from './pcmStreamSink'

function bufferedSource(): BufferedAudioSource {
  return { kind: 'buffered', blob: new Blob(['a']), mimeType: 'audio/mpeg' }
}

function streamedSource(
  format: StreamedAudioSource['format'],
  open: (send: (chunk: Uint8Array) => void, end: () => void) => void = () => {},
): StreamedAudioSource & { cancelled: ReturnType<typeof vi.fn> } {
  const cancelled = vi.fn()
  return {
    kind: 'streamed',
    format,
    mimeType: format === 'mp3-chunks' ? 'audio/mpeg' : 'audio/wav',
    cancelled,
    async pipe(observer) {
      open(chunk => observer.onChunk(chunk), () => observer.onEnd())
    },
    cancel: cancelled,
  }
}

beforeEach(() => setTtsProvider('cosyvoice'))
afterEach(() => vi.unstubAllGlobals())

describe('stream sink selection', () => {
  it('routes mp3 chunks to the MediaSource sink only when the container is playable', () => {
    const sink = new MediaSourceStreamSink()
    vi.stubGlobal('MediaSource', { isTypeSupported: (type: string) => type === 'audio/mpeg' })

    expect(sink.canPlay(streamedSource('mp3-chunks'))).toBe(true)
    expect(sink.canPlay(streamedSource('wav-pcm-chunks'))).toBe(false)
    expect(sink.canPlay(bufferedSource())).toBe(false)
  })

  it('gives up on the MediaSource sink when the WebView cannot decode the container', () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: () => false })
    expect(new MediaSourceStreamSink().canPlay(streamedSource('mp3-chunks'))).toBe(false)
  })

  it('routes only WAV/PCM streams to the PCM sink', () => {
    const sink = new PcmStreamSink()
    expect(sink.canPlay(streamedSource('wav-pcm-chunks'))).toBe(true)
    expect(sink.canPlay(streamedSource('mp3-chunks'))).toBe(false)
    expect(sink.canPlay(bufferedSource())).toBe(false)
  })

  it('cancels the source without touching audio devices when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = streamedSource('wav-pcm-chunks')

    await new PcmStreamSink().play(source, { signal: controller.signal })

    expect(source.cancelled).toHaveBeenCalled()
  })

  it('picks the first sink that claims the source and reports when none can', () => {
    const streamed = streamedSource('mp3-chunks')
    const picky: AudioSink = { id: 'no', canPlay: () => false, play: vi.fn() }
    const open: AudioSink = { id: 'yes', canPlay: () => true, play: vi.fn() }

    expect(findAudioSink([picky, open], streamed)?.id).toBe('yes')
    expect(findAudioSink([picky], streamed)).toBeNull()
    expect(findAudioSink([picky], bufferedSource())).toBeNull()
  })
})

describe('TtsEngine streaming routing', () => {
  it('plays a provider stream through the matching sink', async () => {
    const source = streamedSource('mp3-chunks')
    const provider: TtsProvider = {
      id: 'cosyvoice',
      synthesize: vi.fn(),
      stream: vi.fn().mockResolvedValue({ status: 'ready', source }),
    }
    const play = vi.fn().mockResolvedValue(undefined)
    const sink: AudioSink = { id: 'stream', canPlay: () => true, play }

    const engine = new TtsEngine([provider], { sinks: [sink] })
    await expect(engine.speakTextStreaming('hello', 'voice-1')).resolves.toEqual({ status: 'played' })

    expect(provider.stream).toHaveBeenCalledWith(
      { text: 'hello', voiceId: 'voice-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(play).toHaveBeenCalledWith(source, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('falls back to buffered synthesis when no sink can play the stream', async () => {
    const source = streamedSource('mp3-chunks')
    const provider: TtsProvider = {
      id: 'cosyvoice',
      synthesize: vi.fn().mockResolvedValue({ status: 'skipped', reason: 'buffered_fallback' }),
      stream: vi.fn().mockResolvedValue({ status: 'ready', source }),
    }
    const sink: AudioSink = { id: 'stream', canPlay: () => false, play: vi.fn() }

    const engine = new TtsEngine([provider], { sinks: [sink] })
    await expect(engine.speakTextStreaming('hello', 'voice-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'buffered_fallback',
    })

    expect(source.cancelled).toHaveBeenCalled()
    expect(provider.synthesize).toHaveBeenCalledOnce()
  })

  it('keeps buffered synthesis for sinks that need a complete audio file', async () => {
    const provider: TtsProvider = {
      id: 'cosyvoice',
      synthesize: vi.fn().mockResolvedValue({ status: 'skipped', reason: 'buffered_only' }),
      stream: vi.fn(),
    }
    const engine = new TtsEngine([provider], {
      sinks: [{ id: 'lip-sync', canPlay: () => false, play: vi.fn() }],
      preferBuffered: () => true,
    })

    await expect(engine.speakTextStreaming('hello', 'voice-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'buffered_only',
    })
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('propagates provider stream preflight skips without touching sinks', async () => {
    const provider: TtsProvider = {
      id: 'cosyvoice',
      synthesize: vi.fn(),
      stream: vi.fn().mockResolvedValue({ status: 'skipped', reason: 'missing_api_key' }),
    }
    const play = vi.fn()
    const engine = new TtsEngine([provider], { sinks: [{ id: 'stream', canPlay: () => true, play }] })

    await expect(engine.speakTextStreaming('hello', 'voice-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'missing_api_key',
    })
    expect(play).not.toHaveBeenCalled()
    expect(provider.synthesize).not.toHaveBeenCalled()
  })
})
