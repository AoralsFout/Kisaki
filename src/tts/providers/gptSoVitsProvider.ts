import type {
  TtsProvider,
  TtsStreamResult,
  TtsSynthesisResult,
} from '../../application/tts/ttsProvider'
import { loadGptSoVitsConfig } from '../config'
import { buildGptSoVitsStreamUrl, synthesizeWithGptSoVits } from '../gptsovits'
import {
  loadGptSoVitsCharacterParams,
  type GptSoVitsCharacterParams,
} from '../characterVoiceProfile'
import { ChannelAudioStream, type TtsChunkPayload } from '../streams/channelAudioStream'
import { openTauriChunkStream } from '../streams/tauriChunkChannel'

interface GptSoVitsProviderDependencies {
  loadConfig: typeof loadGptSoVitsConfig
  loadCharacterParams(): Promise<GptSoVitsCharacterParams>
  synthesize: typeof synthesizeWithGptSoVits
  openStream(url: string, send: (chunk: TtsChunkPayload) => void): Promise<void>
}

const defaultDependencies: GptSoVitsProviderDependencies = {
  loadConfig: loadGptSoVitsConfig,
  loadCharacterParams: loadGptSoVitsCharacterParams,
  synthesize: synthesizeWithGptSoVits,
  openStream: (url, send) => openTauriChunkStream('gptsovits_tts_stream', { url })(send),
}

export class GptSoVitsProvider implements TtsProvider {
  readonly id = 'gptsovits' as const

  constructor(private readonly dependencies: GptSoVitsProviderDependencies = defaultDependencies) {}

  private async preflight(): Promise<
    | { status: 'ready'; character: GptSoVitsCharacterParams }
    | { status: 'skipped'; reason: string }
  > {
    if (!this.dependencies.loadConfig().apiUrl) return { status: 'skipped', reason: 'missing_api_url' }
    const character = await this.dependencies.loadCharacterParams()
    if (!character.refAudioPath) return { status: 'skipped', reason: 'missing_ref_audio' }
    return { status: 'ready', character }
  }

  async synthesize(
    request: { text: string; voiceId: string },
    context: { signal: AbortSignal; onSynthesisStart?: () => void },
  ): Promise<TtsSynthesisResult> {
    const preflight = await this.preflight()
    if (preflight.status === 'skipped') return preflight
    const { character } = preflight
    if (context.signal.aborted) return { status: 'cancelled' }

    context.onSynthesisStart?.()
    const result = await this.dependencies.synthesize({
      text: request.text,
      refAudioPath: character.refAudioPath,
      promptText: character.promptText || undefined,
      promptLang: character.promptLang || undefined,
      textLang: character.textLang,
    })
    if (context.signal.aborted) return { status: 'cancelled' }
    return {
      status: 'ready',
      source: { kind: 'buffered', blob: result.blob, mimeType: result.format },
    }
  }

  /** GPT-SoVITS 流式固定返回 WAV 头 + 裸 PCM，因此交给 PCM Sink 排程。 */
  async stream(
    request: { text: string; voiceId: string },
    context: { signal: AbortSignal; onSynthesisStart?: () => void },
  ): Promise<TtsStreamResult> {
    const preflight = await this.preflight()
    if (preflight.status === 'skipped') return preflight
    const { character } = preflight
    if (context.signal.aborted) return { status: 'cancelled' }

    const url = buildGptSoVitsStreamUrl(
      request.text,
      character.refAudioPath,
      character.textLang,
      character.promptText || undefined,
      character.promptLang || undefined,
    )
    return {
      status: 'ready',
      source: new ChannelAudioStream({
        format: 'wav-pcm-chunks',
        mimeType: 'audio/wav',
        signal: context.signal,
        onSynthesisStart: context.onSynthesisStart,
        open: send => this.dependencies.openStream(url, send),
      }),
    }
  }
}
