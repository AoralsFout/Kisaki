import { describe, expect, it, vi } from 'vitest'
import { CosyVoiceProvider } from './cosyVoiceProvider'
import { GptSoVitsProvider } from './gptSoVitsProvider'
import type { TtsProvider } from '../../application/tts/ttsProvider'
import { setTtsProvider } from '../config'
import { TtsEngine } from '../speak'

describe('buffered TTS providers', () => {
  it('falls back to buffered synthesis through the provider contract', async () => {
    setTtsProvider('cosyvoice')
    const synthesize = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'provider_preflight' })
    // 该 Provider 不提供流式协议，因此引擎必须回退到批合成路径。
    const provider: TtsProvider = { id: 'cosyvoice', synthesize }
    const engine = new TtsEngine([provider])

    await expect(engine.speakTextStreaming('hello', 'voice-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'provider_preflight',
    })
    expect(synthesize).toHaveBeenCalledWith(
      { text: 'hello', voiceId: 'voice-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('keeps CosyVoice configuration checks ahead of external synthesis', async () => {
    const synthesize = vi.fn()
    const onSynthesisStart = vi.fn()
    const provider = new CosyVoiceProvider({
      loadConfig: async () => ({ apiKey: 'key', model: 'cosyvoice-v1', region: 'beijing' }),
      resolveWsUrl: () => 'wss://example.test/tts',
      synthesize,
      openStream: vi.fn(),
    })

    await expect(provider.synthesize(
      { text: 'hello', voiceId: '' },
      { signal: new AbortController().signal, onSynthesisStart },
    )).resolves.toEqual({ status: 'skipped', reason: 'missing_voice_id' })
    expect(onSynthesisStart).not.toHaveBeenCalled()
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('normalizes CosyVoice command output to an AudioSource', async () => {
    const onSynthesisStart = vi.fn()
    const synthesize = vi.fn().mockResolvedValue({ audio_base64: btoa('abc'), format: 'mp3' })
    const provider = new CosyVoiceProvider({
      loadConfig: async () => ({ apiKey: 'key', model: 'cosyvoice-v1', region: 'beijing' }),
      resolveWsUrl: () => 'wss://example.test/tts',
      synthesize,
      openStream: vi.fn(),
    })

    const result = await provider.synthesize(
      { text: 'hello', voiceId: 'voice-1' },
      { signal: new AbortController().signal, onSynthesisStart },
    )

    expect(onSynthesisStart).toHaveBeenCalledOnce()
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice: 'voice-1', text: 'hello' }))
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.source).toMatchObject({ kind: 'buffered', mimeType: 'audio/mpeg' })
      if (result.source.kind !== 'buffered') throw new Error('expected buffered source')
      expect(result.source.blob.size).toBe(3)
    }
  })

  it('keeps GPT-SoVITS character preflight inside its provider', async () => {
    const synthesize = vi.fn()
    const provider = new GptSoVitsProvider({
      loadConfig: () => ({ apiUrl: 'http://localhost:9880', topK: 5, topP: 1, temperature: 1, speedFactor: 1 }),
      loadCharacterParams: async () => ({
        refAudioPath: '', promptText: '', promptLang: '', textLang: 'ja-JP',
      }),
      synthesize,
      openStream: vi.fn(),
    })

    await expect(provider.synthesize(
      { text: 'hello', voiceId: '' },
      { signal: new AbortController().signal },
    )).resolves.toEqual({ status: 'skipped', reason: 'missing_ref_audio' })
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('normalizes GPT-SoVITS output to the same AudioSource contract', async () => {
    const blob = new Blob(['wave'], { type: 'audio/wav' })
    const synthesize = vi.fn().mockResolvedValue({ blob, format: 'audio/wav' })
    const provider = new GptSoVitsProvider({
      loadConfig: () => ({ apiUrl: 'http://localhost:9880', topK: 5, topP: 1, temperature: 1, speedFactor: 1 }),
      loadCharacterParams: async () => ({
        refAudioPath: 'voice.wav', promptText: 'hello', promptLang: 'en-US', textLang: 'ja-JP',
      }),
      synthesize,
      openStream: vi.fn(),
    })

    const result = await provider.synthesize(
      { text: 'こんにちは', voiceId: '' },
      { signal: new AbortController().signal },
    )

    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      refAudioPath: 'voice.wav',
      textLang: 'ja-JP',
    }))
    expect(result).toEqual({
      status: 'ready',
      source: { kind: 'buffered', blob, mimeType: 'audio/wav' },
    })
  })
})
