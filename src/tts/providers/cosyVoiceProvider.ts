import { invoke } from '@tauri-apps/api/core'
import type { TtsProvider, TtsSynthesisResult } from '../../application/tts/ttsProvider'
import { getWsUrl, loadCosyVoiceConfigSecure } from '../config'

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
}

const defaultDependencies: CosyVoiceProviderDependencies = {
  loadConfig: loadCosyVoiceConfigSecure,
  resolveWsUrl: getWsUrl,
  synthesize: command => invoke<CosyVoiceCommandResult>('cosyvoice_tts', command),
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

  async synthesize(
    request: { text: string; voiceId: string },
    context: { signal: AbortSignal; onSynthesisStart?: () => void },
  ): Promise<TtsSynthesisResult> {
    const config = await this.dependencies.loadConfig()
    if (!config.apiKey) return { status: 'skipped', reason: 'missing_api_key' }
    if (!request.voiceId) return { status: 'skipped', reason: 'missing_voice_id' }
    const wsUrl = this.dependencies.resolveWsUrl(config)
    if (wsUrl.includes('{WorkspaceId}')) return { status: 'skipped', reason: 'missing_workspace_id' }
    if (context.signal.aborted) return { status: 'cancelled' }

    context.onSynthesisStart?.()
    const result = await this.dependencies.synthesize({
      apiKey: config.apiKey,
      model: config.model,
      voice: request.voiceId,
      text: request.text,
      wsUrl,
    })
    if (context.signal.aborted) return { status: 'cancelled' }
    const blob = decodeAudio(result.audio_base64, result.format)
    return { status: 'ready', source: { kind: 'buffered', blob, mimeType: blob.type } }
  }
}
