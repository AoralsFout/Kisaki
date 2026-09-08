import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COSYVOICE_CONFIG, saveCosyVoiceConfig, setTtsProvider } from '../config'
import { TtsEngine } from '../speak'

describe('TtsEngine preflight telemetry', () => {
  beforeEach(() => {
    localStorage.clear()
    setTtsProvider('cosyvoice')
  })

  it('does not report synthesis start for empty text', async () => {
    const onSynthesisStart = vi.fn()
    const result = await new TtsEngine().speakTextStreaming('   ', 'voice', { onSynthesisStart })

    expect(result).toEqual({ status: 'skipped', reason: 'empty_text' })
    expect(onSynthesisStart).not.toHaveBeenCalled()
  })

  it('does not report synthesis start when TTS is disabled', async () => {
    const engine = new TtsEngine()
    engine.setEnabled(false)
    const onSynthesisStart = vi.fn()
    const result = await engine.speakTextStreaming('hello', 'voice', { onSynthesisStart })

    expect(result).toEqual({ status: 'skipped', reason: 'disabled' })
    expect(onSynthesisStart).not.toHaveBeenCalled()
  })

  it('does not report synthesis start when provider configuration is incomplete', async () => {
    saveCosyVoiceConfig({ ...DEFAULT_COSYVOICE_CONFIG, apiKey: '' })
    const onSynthesisStart = vi.fn()
    const result = await new TtsEngine().speakTextStreaming('hello', 'voice', { onSynthesisStart })

    expect(result).toEqual({ status: 'skipped', reason: 'missing_api_key' })
    expect(onSynthesisStart).not.toHaveBeenCalled()
  })
})
