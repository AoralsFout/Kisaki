import type { TtsProvider, TtsSynthesisResult } from '../../application/tts/ttsProvider'
import { loadGptSoVitsConfig } from '../config'
import { synthesizeWithGptSoVits } from '../gptsovits'
import {
  loadGptSoVitsCharacterParams,
  type GptSoVitsCharacterParams,
} from '../characterVoiceProfile'

interface GptSoVitsProviderDependencies {
  loadConfig: typeof loadGptSoVitsConfig
  loadCharacterParams(): Promise<GptSoVitsCharacterParams>
  synthesize: typeof synthesizeWithGptSoVits
}

const defaultDependencies: GptSoVitsProviderDependencies = {
  loadConfig: loadGptSoVitsConfig,
  loadCharacterParams: loadGptSoVitsCharacterParams,
  synthesize: synthesizeWithGptSoVits,
}

export class GptSoVitsProvider implements TtsProvider {
  readonly id = 'gptsovits' as const

  constructor(private readonly dependencies: GptSoVitsProviderDependencies = defaultDependencies) {}

  async synthesize(
    request: { text: string; voiceId: string },
    context: { signal: AbortSignal; onSynthesisStart?: () => void },
  ): Promise<TtsSynthesisResult> {
    if (!this.dependencies.loadConfig().apiUrl) {
      return { status: 'skipped', reason: 'missing_api_url' }
    }
    const character = await this.dependencies.loadCharacterParams()
    if (!character.refAudioPath) return { status: 'skipped', reason: 'missing_ref_audio' }
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
}
