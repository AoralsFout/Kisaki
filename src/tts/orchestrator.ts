import { TtsPlaybackOrchestrator } from '../application/tts/ttsPlaybackOrchestrator'
import { getTtsProvider } from './config'
import { ttsEngine } from './speak'
import { createLogger } from '../utils/logger'

const log = createLogger('TtsOrchestrator')

/** Infrastructure composition for the application-level playback owner. */
export const ttsPlaybackOrchestrator = new TtsPlaybackOrchestrator({
  isEnabled: () => ttsEngine.isEnabled(),
  provider: () => getTtsProvider(),
  play: (text, voiceId, hooks) => ttsEngine.speakTextStreaming(text, voiceId, hooks),
  cancel: () => ttsEngine.cancel(),
})

/** 播放遥测订阅；由组合根在启动时安装一次。 */
export function installTtsPlaybackTelemetry(): void {
  ttsPlaybackOrchestrator.subscribe(snapshot => {
    if (!snapshot) return
    const context = {
      requestId: snapshot.requestId,
      provider: snapshot.provider,
      status: snapshot.state,
      reason: snapshot.reason,
      durationMs: snapshot.finishedAt === null ? undefined : snapshot.finishedAt - snapshot.startedAt,
    }
    if (snapshot.state === 'synthesizing') {
      log.info('tts.synthesis_started', 'TTS 合成开始', {
        requestId: snapshot.requestId,
        provider: snapshot.provider,
        textLength: snapshot.textLength,
        voiceLang: snapshot.voiceLanguage,
      })
    } else if (snapshot.state === 'playing') {
      log.info('tts.first_audio', 'TTS 首段音频开始播放', {
        requestId: snapshot.requestId,
        provider: snapshot.provider,
        latencyMs: (snapshot.firstAudioAt ?? snapshot.startedAt) - snapshot.startedAt,
      })
    } else if (snapshot.finishedAt !== null) {
      if (snapshot.state === 'failed') log.warn('tts.playback_completed', 'TTS 播放结束', undefined, context)
      else log.info('tts.playback_completed', 'TTS 播放结束', context)
    }
  })
}
