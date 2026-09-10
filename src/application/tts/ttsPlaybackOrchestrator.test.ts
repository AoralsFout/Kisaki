import { describe, expect, it, vi } from 'vitest'
import {
  TtsPlaybackOrchestrator,
  type TtsPlaybackEnginePort,
  type TtsPlaybackHooks,
  type TtsPlaybackResult,
} from './ttsPlaybackOrchestrator'

function engine(
  play: (text: string, voiceId: string, hooks: TtsPlaybackHooks) => Promise<TtsPlaybackResult>,
): TtsPlaybackEnginePort {
  return {
    isEnabled: () => true,
    provider: () => 'cosyvoice',
    play: vi.fn(play),
    cancel: vi.fn(),
  }
}

describe('TtsPlaybackOrchestrator', () => {
  it('publishes one canonical playback lifecycle and deduplicates only successful audio', async () => {
    let now = 10
    const port = engine(async (_text, _voiceId, hooks) => {
      hooks.onSynthesisStart?.()
      hooks.onFirstAudio?.()
      return { status: 'played' }
    })
    const orchestrator = new TtsPlaybackOrchestrator(port, () => now++)
    const states: string[] = []
    orchestrator.subscribe(snapshot => { if (snapshot) states.push(snapshot.state) })

    await expect(orchestrator.play({
      requestId: 'request-1',
      text: 'hello',
      voiceId: 'voice-1',
      voiceLanguage: 'en-US',
    })).resolves.toEqual({ status: 'played' })
    await expect(orchestrator.play({
      requestId: 'request-2',
      text: 'hello',
      voiceId: 'voice-1',
      voiceLanguage: 'en-US',
    })).resolves.toEqual({ status: 'skipped', reason: 'duplicate' })

    expect(states).toEqual(['preparing', 'synthesizing', 'playing', 'played', 'skipped'])
    expect(port.play).toHaveBeenCalledOnce()
    expect(orchestrator.current()).toMatchObject({ state: 'skipped', reason: 'duplicate' })
  })

  it('terminalizes cancellation immediately and ignores late provider callbacks', async () => {
    let resolvePlayback!: (result: TtsPlaybackResult) => void
    let hooks!: TtsPlaybackHooks
    const port = engine((_text, _voiceId, value) => {
      hooks = value
      return new Promise(resolve => { resolvePlayback = resolve })
    })
    const orchestrator = new TtsPlaybackOrchestrator(port, () => 20)
    const playback = orchestrator.play({
      requestId: 'request-1',
      text: 'hello',
      voiceId: 'voice-1',
      voiceLanguage: 'en-US',
    })

    expect(orchestrator.cancel('user-cancelled', true)).toBe(true)
    hooks.onFirstAudio?.()
    resolvePlayback({ status: 'played' })

    await expect(playback).resolves.toEqual({ status: 'cancelled', reason: 'user-cancelled' })
    expect(port.cancel).toHaveBeenCalledOnce()
    expect(orchestrator.current()).toMatchObject({ state: 'cancelled', reason: 'user-cancelled' })
  })

  it('keeps a superseded provider failure from replacing the newer session', async () => {
    let rejectOld!: (error: Error) => void
    const port = engine(vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
      .mockResolvedValueOnce({ status: 'played' }))
    const orchestrator = new TtsPlaybackOrchestrator(port, () => 30)
    const oldPlayback = orchestrator.play({
      requestId: 'old', text: 'old', voiceId: 'voice', voiceLanguage: 'en-US',
    })
    const newPlayback = orchestrator.play({
      requestId: 'new', text: 'new', voiceId: 'voice', voiceLanguage: 'en-US',
    })
    rejectOld(new Error('late failure'))

    await expect(oldPlayback).resolves.toEqual({ status: 'cancelled', reason: 'superseded' })
    await expect(newPlayback).resolves.toEqual({ status: 'played' })
    expect(orchestrator.current()).toMatchObject({ requestId: 'new', state: 'played' })
  })

  it('owns disabled and provider-none preflight without invoking a provider', async () => {
    const port = engine(async () => ({ status: 'played' }))
    port.isEnabled = () => false
    const orchestrator = new TtsPlaybackOrchestrator(port)
    await expect(orchestrator.play({
      text: 'hello',
      voiceId: '',
      voiceLanguage: 'en-US',
    })).resolves.toEqual({ status: 'skipped', reason: 'disabled' })

    port.isEnabled = () => true
    port.provider = () => 'none'
    await expect(orchestrator.play({
      text: 'again',
      voiceId: '',
      voiceLanguage: 'en-US',
    })).resolves.toEqual({ status: 'skipped', reason: 'provider_none' })
    expect(port.play).not.toHaveBeenCalled()
  })

  it('allows retry after failure and after explicit dedupe reset', async () => {
    const port = engine(vi.fn()
      .mockResolvedValueOnce({ status: 'failed', reason: 'network' })
      .mockResolvedValue({ status: 'played' }))
    const orchestrator = new TtsPlaybackOrchestrator(port)
    const request = { text: 'retry me', voiceId: 'voice', voiceLanguage: 'en-US' }

    await expect(orchestrator.play(request)).resolves.toMatchObject({ status: 'failed' })
    await expect(orchestrator.play(request)).resolves.toEqual({ status: 'played' })
    orchestrator.cancel('history-changed', true)
    await expect(orchestrator.play(request)).resolves.toEqual({ status: 'played' })
    expect(port.play).toHaveBeenCalledTimes(3)
  })
})
