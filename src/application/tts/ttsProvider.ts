import type { TtsPlaybackHooks } from './ttsPlaybackOrchestrator'

export interface BufferedAudioSource {
  kind: 'buffered'
  blob: Blob
  mimeType: string
}

export type AudioSource = BufferedAudioSource

export interface TtsSynthesisRequest {
  text: string
  voiceId: string
}

export interface TtsSynthesisContext extends TtsPlaybackHooks {
  signal: AbortSignal
}

export type TtsSynthesisResult =
  | { status: 'ready'; source: AudioSource }
  | { status: 'skipped'; reason: string }
  | { status: 'cancelled' }

/** A provider owns configuration/protocol differences and only produces audio. */
export interface TtsProvider {
  readonly id: 'cosyvoice' | 'gptsovits'
  synthesize(request: TtsSynthesisRequest, context: TtsSynthesisContext): Promise<TtsSynthesisResult>
}
