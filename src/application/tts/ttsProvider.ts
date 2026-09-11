import type { TtsPlaybackHooks } from './ttsPlaybackOrchestrator'

export interface BufferedAudioSource {
  kind: 'buffered'
  blob: Blob
  mimeType: string
}

/** Wire format of a streamed source; decides which sink can consume it. */
export type StreamedAudioFormat = 'mp3-chunks' | 'wav-pcm-chunks'

export interface AudioStreamObserver {
  onChunk(chunk: Uint8Array): void
  onEnd(): void
  onError(error: Error): void
}

/**
 * Audio that arrives incrementally. `pipe` starts production and forwards every
 * chunk to the observer until the producer ends or fails; it resolves once the
 * producer has stopped and therefore never rejects for producer-side errors.
 */
export interface StreamedAudioSource {
  kind: 'streamed'
  format: StreamedAudioFormat
  mimeType: string
  pipe(observer: AudioStreamObserver): Promise<void>
  /** Stop producing and release transport resources. */
  cancel(): void
}

export type AudioSource = BufferedAudioSource | StreamedAudioSource

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

export type TtsStreamResult =
  | { status: 'ready'; source: StreamedAudioSource }
  | { status: 'skipped'; reason: string }
  | { status: 'cancelled' }

/** A provider owns configuration/protocol differences and only produces audio. */
export interface TtsProvider {
  readonly id: 'cosyvoice' | 'gptsovits'
  synthesize(request: TtsSynthesisRequest, context: TtsSynthesisContext): Promise<TtsSynthesisResult>
  /** Providers without an incremental protocol omit this and fall back to `synthesize`. */
  stream?(request: TtsSynthesisRequest, context: TtsSynthesisContext): Promise<TtsStreamResult>
}
