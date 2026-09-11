import type { AudioSink, AudioSinkContext } from '../../application/tts/audioSink'
import type { AudioSource, AudioStreamObserver } from '../../application/tts/ttsProvider'
import { createLogger } from '../../utils/logger'

const log = createLogger('TtsMediaSink')

const SOURCE_OPEN_TIMEOUT_MS = 5_000
const STREAM_TIMEOUT_MS = 60_000
const FLUSH_TIMEOUT_MS = 10_000
const DEFAULT_PLAYBACK_TIMEOUT_MS = 30_000

function waitForSourceBufferOpen(mediaSource: MediaSource, mimeType: string): Promise<SourceBuffer> {
  return new Promise<SourceBuffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MediaSource 打开超时')), SOURCE_OPEN_TIMEOUT_MS)
    mediaSource.onsourceopen = () => {
      clearTimeout(timeout)
      try {
        resolve(mediaSource.addSourceBuffer(mimeType))
      } catch (error) {
        reject(new Error(`添加 SourceBuffer 失败: ${error}`))
      }
    }
  })
}

/** 等待 SourceBuffer 把已入队的字节全部追加完毕。 */
function waitForBufferFlush(sourceBuffer: SourceBuffer, pendingChunks: ArrayBuffer[]): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!sourceBuffer.updating && pendingChunks.length === 0) {
      resolve()
      return
    }
    const onUpdateEnd = () => {
      if (!sourceBuffer.updating && pendingChunks.length === 0) {
        sourceBuffer.removeEventListener('updateend', onUpdateEnd)
        resolve()
      }
    }
    sourceBuffer.addEventListener('updateend', onUpdateEnd)
  })
}

/** 等待音频真正播放结束；时长不可知时退化为固定上限。 */
function waitForPlaybackEnd(audio: HTMLAudioElement, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => finish()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout !== null) clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    audio.onended = () => finish()
    audio.onerror = () => finish(new Error('TTS 音频播放失败'))
    const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
      ? Math.min(audio.duration * 1000 + 5_000, STREAM_TIMEOUT_MS)
      : DEFAULT_PLAYBACK_TIMEOUT_MS
    timeout = setTimeout(() => {
      audio.pause()
      finish(new Error('TTS 音频播放超时'))
    }, durationMs)

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * 流式播放：把逐帧到达的容器音频渐进追加到 MediaSource + SourceBuffer 后播放。
 * 依赖 WebView 对该容器格式的支持，因此 `canPlay` 会先行探测。
 */
export class MediaSourceStreamSink implements AudioSink {
  readonly id = 'media-source-stream'

  canPlay(source: AudioSource): boolean {
    return source.kind === 'streamed'
      && source.format === 'mp3-chunks'
      && typeof MediaSource !== 'undefined'
      && MediaSource.isTypeSupported(source.mimeType)
  }

  async play(source: AudioSource, context: AudioSinkContext): Promise<void> {
    if (source.kind !== 'streamed') throw new Error(`${this.id} requires a streamed audio source`)

    const { signal, onFirstAudio } = context
    if (signal.aborted) {
      source.cancel()
      return
    }

    const mediaSource = new MediaSource()
    const audio = new Audio()
    const blobUrl = URL.createObjectURL(mediaSource)
    audio.src = blobUrl

    // 取消时立即暂停播放（后端任务会因读超时或服务端结束而自行收尾）
    const onAbort = () => {
      try { audio.pause() } catch { /* 忽略 */ }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const sourceBuffer = await waitForSourceBufferOpen(mediaSource, source.mimeType)
      if (signal.aborted) return

      const pendingChunks: ArrayBuffer[] = []
      let streamError: string | null = null
      let firstChunkAppended = false
      let audioPlayPromise: Promise<void> | null = null
      let resolveStreamComplete: (() => void) | null = null
      const streamComplete = new Promise<void>(resolve => { resolveStreamComplete = resolve })

      const flushBuffer = () => {
        if (sourceBuffer.updating || pendingChunks.length === 0 || streamError) return
        try {
          sourceBuffer.appendBuffer(pendingChunks.shift()!)
        } catch (error) {
          streamError = (error as Error).message || '追加音频缓冲失败'
          resolveStreamComplete?.()
        }
      }

      sourceBuffer.addEventListener('updateend', flushBuffer)
      sourceBuffer.addEventListener('error', () => {
        streamError = '音频缓冲解码失败'
        resolveStreamComplete?.()
      })

      const observer: AudioStreamObserver = {
        onChunk: bytes => {
          if (signal.aborted || streamError) return
          pendingChunks.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
          flushBuffer()
          if (!firstChunkAppended) {
            firstChunkAppended = true
            audioPlayPromise = audio.play()
              .then(() => { onFirstAudio?.() })
              .catch(error => {
                streamError = (error as Error).message || '音频播放启动失败'
                resolveStreamComplete?.()
              })
          }
        },
        onEnd: () => {
          resolveStreamComplete?.()
          flushBuffer()
        },
        onError: error => {
          streamError = error.message || '音频流失败'
          resolveStreamComplete?.()
        },
      }

      // pipe 在生产者结束后 resolve；结束标记通常先一步到达。
      void source.pipe(observer).catch(error => {
        if (streamError) return
        streamError = error instanceof Error ? error.message : String(error)
        resolveStreamComplete?.()
      })

      if (!signal.aborted && !streamError) {
        await Promise.race([
          streamComplete,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('等待 TTS 音频流超时')),
            STREAM_TIMEOUT_MS,
          )),
        ])
        if (!firstChunkAppended || !audioPlayPromise) throw new Error('TTS 未返回可播放音频')
        await audioPlayPromise
        if (streamError) throw new Error(streamError)
        await Promise.race([
          waitForBufferFlush(sourceBuffer, pendingChunks),
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('刷新 TTS 音频缓冲超时')),
            FLUSH_TIMEOUT_MS,
          )),
        ])
        if (streamError) throw new Error(streamError)
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream() } catch { /* 忽略 */ }
        }
        await waitForPlaybackEnd(audio, signal)
      }
      if (streamError) throw new Error(streamError)
    } finally {
      signal.removeEventListener('abort', onAbort)
      source.cancel()
      cleanupMediaSource(mediaSource, blobUrl, audio)
    }
  }
}

/** 清理 MediaSource / blob URL / Audio，避免提前返回或异常路径泄漏资源。 */
function cleanupMediaSource(mediaSource: MediaSource, blobUrl: string, audio: HTMLAudioElement) {
  try {
    audio.pause()
    audio.src = ''
    if (mediaSource.readyState !== 'closed') {
      try { mediaSource.endOfStream() } catch (error) {
        log.warn('tts.cleanup_media_source.warn', 'MediaSource endOfStream 失败', error)
      }
    }
    URL.revokeObjectURL(blobUrl)
  } catch (error) {
    log.warn('tts.cleanup_media_source.warn', '清理 MediaSource 资源失败', error)
  }
}
