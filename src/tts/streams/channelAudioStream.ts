import type {
  AudioStreamObserver,
  StreamedAudioFormat,
  StreamedAudioSource,
} from '../../application/tts/ttsProvider'

/** 后端流式音频帧（对应 Rust TtsChunk） */
export interface TtsChunkPayload {
  data: string
  format: string
  is_last: boolean
}

export interface ChannelAudioStreamOptions {
  format: StreamedAudioFormat
  mimeType: string
  signal: AbortSignal
  onSynthesisStart?: () => void
  /**
   * 打开请求作用域的传输通道，把收到的每一帧转发给 `send`。
   * 后端发送完毕后 resolve。
   */
  open(send: (chunk: TtsChunkPayload) => void): Promise<void>
}

function decodeChunk(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 由请求作用域传输通道支撑的流式音源。
 * 因为每次播放独占自己的传输通道，帧里不需要流 id。
 */
export class ChannelAudioStream implements StreamedAudioSource {
  readonly kind = 'streamed'
  readonly format: StreamedAudioFormat
  readonly mimeType: string
  private cancelled = false

  constructor(private readonly options: ChannelAudioStreamOptions) {
    this.format = options.format
    this.mimeType = options.mimeType
  }

  async pipe(observer: AudioStreamObserver): Promise<void> {
    if (this.cancelled || this.options.signal.aborted) return
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      observer.onEnd()
    }
    const send = (chunk: TtsChunkPayload) => {
      if (this.cancelled || ended) return
      if (chunk.is_last) {
        end()
        return
      }
      try {
        observer.onChunk(decodeChunk(chunk.data))
      } catch { /* 跳过损坏的音频块 */ }
    }

    this.options.onSynthesisStart?.()
    try {
      await this.options.open(send)
      // 取消后的收尾不应再被当作正常结束上报给 Sink。
      if (!this.cancelled) end()
    } catch (error) {
      if (this.cancelled) return
      ended = true
      observer.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  cancel(): void {
    this.cancelled = true
  }
}
