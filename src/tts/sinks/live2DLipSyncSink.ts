import type { AudioSink, AudioSinkContext } from '../../application/tts/audioSink'
import type { AudioSource } from '../../application/tts/ttsProvider'
import { createLogger } from '../../utils/logger'

const log = createLogger('TtsLipSyncSink')

/** Live2D 口型播放器：播放给定音频 URL 并驱动模型口型；signal 中止即停。 */
export type VoicePlayer = (audioUrl: string, signal: AbortSignal) => Promise<void>

/**
 * 通过 Live2D 语音播放器播放缓冲音频，让模型同步口型。
 * 播放器缺失或播放失败时，降级到其他播放器。
 */
export class Live2DLipSyncSink implements AudioSink {
  readonly id = 'live2d-lip-sync'

  constructor(
    private readonly resolveVoicePlayer: () => VoicePlayer | null,
    private readonly fallback: AudioSink,
  ) {}

  canPlay(source: AudioSource): boolean {
    return source.kind === 'buffered' && this.resolveVoicePlayer() !== null
  }

  async play(source: AudioSource, context: AudioSinkContext): Promise<void> {
    const voicePlayer = this.resolveVoicePlayer()
    if (source.kind !== 'buffered' || !voicePlayer) {
      await this.fallback.play(source, context)
      return
    }

    const url = URL.createObjectURL(source.blob)
    try {
      await voicePlayer(url, context.signal)
      // easy-live2d 的 playVoice Promise 在音频实例开始播放后返回。
      context.onFirstAudio?.()
    } catch (error) {
      log.warn('tts.lip_sync.warn', 'playVoice 口型播放失败，回退到默认音频 Sink', error)
      if (!context.signal.aborted) await this.fallback.play(source, context)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}
