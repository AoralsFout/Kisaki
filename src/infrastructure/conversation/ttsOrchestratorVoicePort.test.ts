import { describe, expect, it, vi } from 'vitest'
import { TtsOrchestratorVoicePort } from './ttsOrchestratorVoicePort'

function orchestrator() {
  return {
    play: vi.fn(() => new Promise<never>(() => {})),
    cancel: vi.fn(() => true),
  }
}

const request = {
  requestId: 'request-1',
  text: 'こんにちは',
  voiceId: 'voice-x',
  voiceLanguage: 'ja-JP',
}

describe('TtsOrchestratorVoicePort', () => {
  it('hands the request to the orchestrator without waiting for playback', () => {
    const tts = orchestrator()
    const port = new TtsOrchestratorVoicePort(tts)

    // 播放永不 resolve；play() 仍然同步返回，回合因此不会被语音拖住。
    expect(port.play(request)).toBeUndefined()
    expect(tts.play).toHaveBeenCalledWith({
      requestId: 'request-1',
      text: 'こんにちは',
      voiceId: 'voice-x',
      voiceLanguage: 'ja-JP',
      deduplicate: undefined,
    })
  })

  it('forwards the deduplicate flag', () => {
    const tts = orchestrator()

    new TtsOrchestratorVoicePort(tts).play({ ...request, deduplicate: false })

    expect(tts.play).toHaveBeenCalledWith(expect.objectContaining({ deduplicate: false }))
  })

  it('cancels with the caller reason and keeps dedupe unless asked to reset', () => {
    const tts = orchestrator()
    const port = new TtsOrchestratorVoicePort(tts)

    port.cancel('new-message')
    expect(tts.cancel).toHaveBeenLastCalledWith('new-message', false)

    port.cancel('new-message', true)
    expect(tts.cancel).toHaveBeenLastCalledWith('new-message', true)
  })
})
