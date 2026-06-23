/**
 * GPT-SoVITS HTTP API 客户端
 *
 * 通过本地 HTTP API 调用 GPT-SoVITS 进行语音合成。
 * 参考 API: e:\AI\GPT-SoVITS-v2pro-20250604\api_v2.py
 *
 * 支持批处理模式（等待完整音频返回后播放）。
 */
import { invoke } from '@tauri-apps/api/core'
import { loadGptSoVitsConfig } from './config'
import type { GptSoVitsConfig } from './types'
import { createLogger } from '../utils/logger'

const log = createLogger('GptSoVits')

/**
 * GPT-SoVITS 语言代码映射（BCP-47 → GPT-SoVITS 格式）
 * GPT-SoVITS 使用简码如 "ja"、"zh"、"en"，而非 "ja-JP"、"zh-CN" 这类 BCP-47 格式
 */
const LANG_MAP: Record<string, string> = {
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'zh-HK': 'yue',
  'ja-JP': 'ja',
  'en-US': 'en',
  'ko-KR': 'ko',
}

/** 将 BCP-47 语言代码标准化为 GPT-SoVITS 兼容格式 */
function normalizeLang(lang: string): string {
  return LANG_MAP[lang] || lang
}

/** 合成参数（全部由角色配置提供，无全局默认） */
export interface GptSoVitsSynthesizeParams {
  text: string
  /** 参考音频路径（必填） */
  refAudioPath: string
  /** 参考音频转录文本 */
  promptText?: string
  /** 参考音频语言 */
  promptLang?: string
  /** 合成文本语言（必填，来自角色 voiceLanguage） */
  textLang: string
}

/** GPT-SoVITS API 返回的音频数据 */
export interface GptSoVitsResult {
  /** 音频 blob（WAV / OGG / AAC） */
  blob: Blob
  /** 音频格式 */
  format: string
}

/**
 * 使用 GPT-SoVITS 合成语音（批处理模式）
 *
 * @param params 合成参数
 * @param overrides 可选覆盖全局配置（apiUrl, topK, topP, 等）
 * @returns 音频 blob 与格式
 */
export async function synthesizeWithGptSoVits(
  params: GptSoVitsSynthesizeParams,
  overrides?: Partial<GptSoVitsConfig>,
): Promise<GptSoVitsResult> {
  const config = { ...loadGptSoVitsConfig(), ...overrides }

  if (!config.apiUrl) {
    throw new Error('GPT-SoVITS API URL 未配置')
  }
  if (!params.refAudioPath) {
    throw new Error('参考音频路径未配置')
  }

  // 标准化语言代码（GPT-SoVITS 使用简码，如 "ja" 而非 "ja-JP"）
  const textLang = normalizeLang(params.textLang)
  const promptLang = params.promptLang ? normalizeLang(params.promptLang) : undefined

  // 标准化路径（反斜杠 → 正斜杠，避免 URL 编码或解析问题）
  const refAudioPath = params.refAudioPath.replace(/\\/g, '/')

  // 构建请求参数
  const searchParams = new URLSearchParams()
  searchParams.set('text', params.text)
  searchParams.set('text_lang', textLang)
  searchParams.set('ref_audio_path', refAudioPath)
  if (params.promptText) searchParams.set('prompt_text', params.promptText)
  if (promptLang) searchParams.set('prompt_lang', promptLang)
  searchParams.set('media_type', 'wav')
  searchParams.set('streaming_mode', '0')
  searchParams.set('top_k', String(config.topK))
  searchParams.set('top_p', String(config.topP))
  searchParams.set('temperature', String(config.temperature))
  searchParams.set('speed_factor', String(config.speedFactor))

  // 拼装完整 URL
  const baseUrl = config.apiUrl.replace(/\/+$/, '')
  const url = `${baseUrl}/tts?${searchParams.toString()}`

  log.debug('GPT-SoVITS 请求: %s (text=%s..., lang=%s, ref=%s)',
    baseUrl, params.text.slice(0, 30), textLang, refAudioPath)

  // 通过 Rust 后端代理请求（绕过 webview CORS 限制）
  const result = await invoke<{ audio_base64: string; format: string }>('gptsovits_tts', { url })

  const format = result.format
  const mimeTypes: Record<string, string> = {
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    raw: 'audio/L16',
  }
  const mimeType = mimeTypes[format] || 'audio/wav'

  // 将 base64 解码为 blob
  const binaryStr = atob(result.audio_base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
  const blob = new Blob([bytes], { type: mimeType })

  log.info('GPT-SoVITS 合成完成: %d 字符 → %d bytes (%s)',
    params.text.length, blob.size, format)

  return { blob, format: mimeType }
}

/**
 * GPT-SoVITS 流式合成 URL 构建（不含 host）
 * 调用方将结果传给 Rust gptsovits_tts_stream 命令
 */
export function buildGptSoVitsStreamUrl(
  text: string,
  refAudioPath: string,
  textLang: string,
  promptText?: string,
  promptLang?: string,
): string {
  const config = loadGptSoVitsConfig()

  const normalizedTextLang = normalizeLang(textLang)
  const normalizedPromptLang = promptLang ? normalizeLang(promptLang) : undefined
  const normalizedPath = refAudioPath.replace(/\\/g, '/')

  const searchParams = new URLSearchParams()
  searchParams.set('text', text)
  searchParams.set('text_lang', normalizedTextLang)
  searchParams.set('ref_audio_path', normalizedPath)
  if (promptText) searchParams.set('prompt_text', promptText)
  if (normalizedPromptLang) searchParams.set('prompt_lang', normalizedPromptLang)
  // 流式固定 wav：服务端首帧返回 44 字节 WAV 头（含真实采样率），其后为裸 PCM。
  // 前端 PcmStreamPlayer 解析头部后按 PCM 连续排程播放（ogg/aac 无法逐帧解码，故不可用于流式）。
  searchParams.set('media_type', 'wav')
  searchParams.set('streaming_mode', '1')
  searchParams.set('top_k', String(config.topK))
  searchParams.set('top_p', String(config.topP))
  searchParams.set('temperature', String(config.temperature))
  searchParams.set('speed_factor', String(config.speedFactor))

  const baseUrl = config.apiUrl.replace(/\/+$/, '')
  return `${baseUrl}/tts?${searchParams.toString()}`
}

/**
 * 通过 HTMLAudioElement 播放 GPT-SoVITS 返回的 blob
 * 返回 Promise，播放结束或出错时 resolve
 */
export function playAudioBlob(
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)

      audio.onended = () => {
        URL.revokeObjectURL(url)
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('音频播放失败'))
      }

      if (signal) {
        if (signal.aborted) {
          audio.pause()
          audio.src = ''
          URL.revokeObjectURL(url)
          resolve()
          return
        }
        signal.addEventListener('abort', () => {
          audio.pause()
          audio.src = ''
          URL.revokeObjectURL(url)
          resolve()
        }, { once: true })
      }

      audio.play().catch((err) => {
        URL.revokeObjectURL(url)
        reject(err)
      })
    } catch (err) {
      reject(err)
    }
  })
}

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
      if (combined.length < 44) {
        this.headerBuf = combined
        return
      }
      this.parseWavHeader(combined)
      this.headerParsed = true
      this.headerBuf = new Uint8Array(0)
      data = combined.subarray(44)
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
    const view = new DataView(buf.buffer, buf.byteOffset, 44)
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
