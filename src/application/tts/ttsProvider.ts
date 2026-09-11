import type { TtsPlaybackHooks } from './ttsPlaybackOrchestrator'

export interface BufferedAudioSource {
  kind: 'buffered'
  blob: Blob
  mimeType: string
}

/** 流式音源的传输格式，决定哪个播放器能消费它。 */
export type StreamedAudioFormat = 'mp3-chunks' | 'wav-pcm-chunks'

export interface AudioStreamObserver {
  onChunk(chunk: Uint8Array): void
  onEnd(): void
  onError(error: Error): void
}

/**
 * 增量到达的音频。`pipe` 启动生产并把每个分片转发给 observer，直到生产方结束或失败；
 * 它在生产方停止后 resolve，因此不会因生产方错误而 reject。
 */
export interface StreamedAudioSource {
  kind: 'streamed'
  format: StreamedAudioFormat
  mimeType: string
  pipe(observer: AudioStreamObserver): Promise<void>
  /** 停止生产并释放传输资源。 */
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

/** provider 只负责产出音频，并自行消化配置与协议差异。 */
export interface TtsProvider {
  readonly id: 'cosyvoice' | 'gptsovits'
  synthesize(request: TtsSynthesisRequest, context: TtsSynthesisContext): Promise<TtsSynthesisResult>
  /** 不支持增量协议的 provider 不实现该方法，回退到 `synthesize`。 */
  stream?(request: TtsSynthesisRequest, context: TtsSynthesisContext): Promise<TtsStreamResult>
}
