import { invoke } from '@tauri-apps/api/core'
import type {
  TtsProvider,
  TtsStreamResult,
  TtsSynthesisResult,
} from '../../application/tts/ttsProvider'
import { getWsUrl, loadCosyVoiceConfigSecure } from '../config'
import { ChannelAudioStream, type TtsChunkPayload } from '../streams/channelAudioStream'
import { openTauriChunkStream } from '../streams/tauriChunkChannel'

interface CosyVoiceCommandResult {
  audio_base64: string
  format: string
}

interface CosyVoiceProviderDependencies {
  loadConfig: typeof loadCosyVoiceConfigSecure
  resolveWsUrl: typeof getWsUrl
  synthesize(command: {
    apiKey: string
    model: string
    voice: string
    text: string
    wsUrl: string
  }): Promise<CosyVoiceCommandResult>
  openStream(
    command: { apiKey: string; model: string; voice: string; text: string; wsUrl: string },
    send: (chunk: TtsChunkPayload) => void,
  ): Promise<void>
}

const defaultDependencies: CosyVoiceProviderDependencies = {
  loadConfig: loadCosyVoiceConfigSecure,
  resolveWsUrl: getWsUrl,
  synthesize: command => invoke<CosyVoiceCommandResult>('cosyvoice_tts', command),
  openStream: (command, send) => openTauriChunkStream('cosyvoice_tts_stream', { ...command })(send),
}

function decodeAudio(base64: string, format: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
  return new Blob([bytes], { type: mimeType })
}

export class CosyVoiceProvider implements TtsProvider {
  readonly id = 'cosyvoice' as const

  constructor(private readonly dependencies: CosyVoiceProviderDependencies = defaultDependencies) {}

  /** 共享的配置预检：两种模式的前置条件完全一致。 */
  private async preflight(
    voiceId: string,
  ): Promise<
    | { status: 'ready'; apiKey: string; model: string; wsUrl: string }
    | { status: 'skipped'; reason: string }
  > {
    const config = await this.dependencies.loadConfig()
    if (!config.apiKey) return { status: 'skipped', reason: 'missing_api_key' }
    if (!voiceId) return { status: 'skipped', reason: 'missing_voice_id' }
    const wsUrl = this.dependencies.resolveWsUrl(config)
    if (wsUrl.includes('{WorkspaceId}')) return { status: 'skipped', reason: 'missing_workspace_id' }
    return { status: 'ready', apiKey: config.apiKey, model: config.model, wsUrl }
  }

  async synthesize(
    request: { text: string; voiceId: string },
    context: { signal: AbortSignal; onSynthesisStart?: () => void },
  ): Promise<TtsSynthesisResult> {
    const preflight = await this.preflight(request.voiceId)
    if (preflight.status === 'skipped') return preflight
    if (context.signal.aborted) return { status: 'cancelled' }

    context.onSynthesisStart?.()
    const result = await this.dependencies.synthesize({
      apiKey: preflight.apiKey,
      model: preflight.model,
      voice: request.voiceId,
      text: request.text,
      wsUrl: preflight.wsUrl,
    })
    if (context.signal.aborted) return { status: 'cancelled' }
    const blob = decodeAudio(result.audio_base64, result.format)
    return { status: 'ready', source: { kind: 'buffered', blob, mimeType: blob.type } }
  }

  /** CosyVoice 逐帧返回 mp3，因此流式播放交给 MediaSource 类 Sink。 */
  async stream(
    request: { text: string; voiceId: string },
    context: { signal: AbortSignal; onSynthesisStart?: () => void },
  ): Promise<TtsStreamResult> {
    const preflight = await this.preflight(request.voiceId)
    if (preflight.status === 'skipped') return preflight
    if (context.signal.aborted) return { status: 'cancelled' }

    return {
      status: 'ready',
      source: new ChannelAudioStream({
        format: 'mp3-chunks',
        mimeType: 'audio/mpeg',
        signal: context.signal,
        onSynthesisStart: context.onSynthesisStart,
        open: send => this.dependencies.openStream({
          apiKey: preflight.apiKey,
          model: preflight.model,
          voice: request.voiceId,
          text: request.text,
          wsUrl: preflight.wsUrl,
        }, send),
      }),
    }
  }
}
