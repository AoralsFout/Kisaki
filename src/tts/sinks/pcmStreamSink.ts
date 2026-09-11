import type { AudioSink, AudioSinkContext } from '../../application/tts/audioSink'
import type { AudioSource, AudioStreamObserver } from '../../application/tts/ttsProvider'
import { createLogger } from '../../utils/logger'

const log = createLogger('TtsPcmSink')

/** WAV 头固定 44 字节；其后的裸 PCM 才是可播放负载。 */
const WAV_HEADER_BYTES = 44
const PLAYBACK_TIMEOUT_MS = 60_000

/** 拼接两段字节 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Web Audio 流式 PCM 播放器
 *
 * GPT-SoVITS 流式合成返回 [44字节WAV头][裸PCM 16-bit...] 的连续字节流，
 * 网络分片边界任意（既不对齐 WAV 头、也不对齐 PCM 帧）。本类负责：
 *   1. 累积字节，解析首部 44 字节 WAV 头取得真实采样率与声道数
 *   2. 将其后裸 PCM 按帧边界（声道数 × 2 字节）切分，残留不足一帧的字节留待下次
 *   3. 把每段 PCM 转成 AudioBuffer，沿一个递增的时间游标无缝排程到 AudioContext
 *
 * 实现真正的低延迟边收边播，且不依赖 WebView 对 MediaSource/各容器格式的支持。
 */
export class PcmStreamPlayer {
  private ctx: AudioContext
  private sampleRate = 32000
  private numChannels = 1
  private headerParsed = false
  private headerBuf = new Uint8Array(0)
  private leftover = new Uint8Array(0)
  private nextStartTime = 0
  private activeSources = new Set<AudioBufferSourceNode>()
  private ended = false
  private disposed = false
  private resolveDone: (() => void) | null = null
  private readonly donePromise: Promise<void>

  constructor() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctx()
    this.nextStartTime = this.ctx.currentTime
    this.donePromise = new Promise<void>((resolve) => { this.resolveDone = resolve })
    // 自动播放策略可能令 ctx 处于 suspended，主动恢复
    this.ctx.resume().catch(() => { /* ignore */ })
  }

  /** 追加一段网络字节（base64 解码后的原始字节） */
  push(bytes: Uint8Array) {
    if (this.disposed || this.ended) return
    let data = bytes

    // ── 解析 WAV 头（首 44 字节）──
    if (!this.headerParsed) {
      const combined = concatBytes(this.headerBuf, data)
      if (combined.length < WAV_HEADER_BYTES) {
        this.headerBuf = combined
        return
      }
      this.parseWavHeader(combined)
      this.headerParsed = true
      this.headerBuf = new Uint8Array(0)
      data = combined.subarray(WAV_HEADER_BYTES)
      if (data.length === 0) return
    }

    // ── 拼接残留字节，按帧边界切分 ──
    const buf = concatBytes(this.leftover, data)
    const frameBytes = this.numChannels * 2 // 16-bit PCM
    const usable = buf.length - (buf.length % frameBytes)
    if (usable <= 0) {
      this.leftover = buf
      return
    }
    this.leftover = buf.subarray(usable)
    this.schedulePcm(buf.subarray(0, usable))
  }

  /** 解析标准 44 字节 WAV 头，取声道数与采样率（位深固定 16-bit） */
  private parseWavHeader(buf: Uint8Array) {
    const view = new DataView(buf.buffer, buf.byteOffset, WAV_HEADER_BYTES)
    this.numChannels = view.getUint16(22, true) || 1
    this.sampleRate = view.getUint32(24, true) || 32000
  }

  /** 将一段完整帧 PCM 转 AudioBuffer 并排程播放 */
  private schedulePcm(pcm: Uint8Array) {
    if (this.disposed) return
    const frameBytes = this.numChannels * 2
    const frameCount = pcm.length / frameBytes
    if (frameCount <= 0) return

    const audioBuffer = this.ctx.createBuffer(this.numChannels, frameCount, this.sampleRate)
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    for (let ch = 0; ch < this.numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch)
      for (let i = 0; i < frameCount; i++) {
        const offset = (i * this.numChannels + ch) * 2
        channelData[i] = view.getInt16(offset, true) / 32768
      }
    }

    const src = this.ctx.createBufferSource()
    src.buffer = audioBuffer
    src.connect(this.ctx.destination)
    // 沿时间游标排程；首段或出现空档时从 currentTime 起播，避免负延迟报错
    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime)
    src.start(startAt)
    this.nextStartTime = startAt + audioBuffer.duration
    this.activeSources.add(src)
    src.onended = () => {
      this.activeSources.delete(src)
      this.checkDone()
    }
  }

  /** 标记流结束（不再有新字节）；待已排程音频播完即 resolve waitDone */
  end() {
    this.ended = true
    this.checkDone()
  }

  private checkDone() {
    if (this.ended && this.activeSources.size === 0) {
      this.resolveDone?.()
      this.resolveDone = null
    }
  }

  /** 等待全部音频播放完毕 */
  waitDone(): Promise<void> {
    return this.donePromise
  }

  /** 立即停止并释放资源（用于 abort 或清理） */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const src of this.activeSources) {
      try { src.stop() } catch { /* ignore */ }
      try { src.disconnect() } catch { /* ignore */ }
    }
    this.activeSources.clear()
    this.ctx.close().catch(() => { /* ignore */ })
    this.resolveDone?.()
    this.resolveDone = null
  }
}

/**
 * Consumes WAV-header-then-PCM chunks and schedules them through Web Audio.
 * Used when the provider streams raw PCM instead of a container format.
 */
export class PcmStreamSink implements AudioSink {
  readonly id = 'pcm-stream'

  canPlay(source: AudioSource): boolean {
    return source.kind === 'streamed' && source.format === 'wav-pcm-chunks'
  }

  async play(source: AudioSource, context: AudioSinkContext): Promise<void> {
    if (source.kind !== 'streamed') throw new Error(`${this.id} requires a streamed audio source`)

    if (context.signal.aborted) {
      source.cancel()
      return
    }

    const player = new PcmStreamPlayer()
    let receivedBytes = 0
    let firstAudioReported = false
    let streamError: string | null = null

    const onAbort = () => player.dispose()
    context.signal.addEventListener('abort', onAbort, { once: true })

    const observer: AudioStreamObserver = {
      onChunk: bytes => {
        player.push(bytes)
        receivedBytes += bytes.byteLength
        if (!firstAudioReported && receivedBytes > WAV_HEADER_BYTES) {
          firstAudioReported = true
          context.onFirstAudio?.()
        }
      },
      onEnd: () => player.end(),
      onError: error => { streamError = error.message },
    }

    const producer = source.pipe(observer).catch(error => {
      streamError = error instanceof Error ? error.message : String(error)
    })

    try {
      await producer
      if (!context.signal.aborted && !streamError) {
        if (receivedBytes <= WAV_HEADER_BYTES) streamError = '未返回可播放音频'
        player.end()
        if (!streamError) {
          await Promise.race([
            player.waitDone(),
            new Promise<never>((_, reject) => setTimeout(
              () => reject(new Error('TTS 播放超时')),
              PLAYBACK_TIMEOUT_MS,
            )),
          ])
        }
      }
      if (streamError && !context.signal.aborted) throw new Error(streamError)
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      source.cancel()
      player.dispose()
      log.debug('tts.pcm_sink.debug', `PCM 流结束: ${receivedBytes} bytes`)
    }
  }
}
