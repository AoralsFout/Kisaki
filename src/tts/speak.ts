/**
 * CosyVoice TTS 播报服务
 *
 * 调用 Rust 后端的 WebSocket TTS 命令合成语音，并通过 HTMLAudioElement 播放。
 * 支持两种模式：
 *   1. speakText — 批处理模式（等全部合成完再播放）
 *   2. speakTextStreaming — 流式模式（边合成边播放，通过 MediaSource 渐进式追加音频帧）
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { loadCosyVoiceConfig, getWsUrl } from './config'

/** TTS 存储 key */
const ENABLED_KEY = 'deskpet-tts-enabled'

/** 语音播报是否开启 */
export function isTtsEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

/** 设置语音播报开关 */
export function setTtsEnabled(enabled: boolean) {
  localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false')
}

/** 当前控制对象 */
let currentController: AbortController | null = null

/** 流式音频帧事件结构（对应 Rust TtsChunk） */
interface TtsChunk {
  data: string
  format: string
  is_last: boolean
}

/** 合成并播报文本（批处理模式） */
export async function speakText(text: string, voiceId: string): Promise<void> {
  if (!isTtsEnabled()) return
  cancelSpeak()

  const controller = new AbortController()
  currentController = controller

  const cvConfig = loadCosyVoiceConfig()
  if (!cvConfig.apiKey || !voiceId) return

  const wsUrl = getWsUrl(cvConfig)
  if (wsUrl.includes('{WorkspaceId}')) return

  try {
    const result = await invoke<TtsCommandResult>('cosyvoice_tts', {
      apiKey: cvConfig.apiKey,
      model: cvConfig.model,
      voice: voiceId,
      text: text,
      wsUrl: wsUrl,
    })

    if (controller.signal.aborted) return
    await playAudio(result.audio_base64, result.format, controller.signal)
  } catch (err) {
    console.warn('[TTS] 批处理播报失败:', err)
  } finally {
    if (currentController === controller) {
      currentController = null
    }
  }
}

/** 合成并流式播报文本（边接收边播放，延迟更低） */
export async function speakTextStreaming(text: string, voiceId: string): Promise<void> {
  if (!isTtsEnabled()) return
  cancelSpeak()

  const controller = new AbortController()
  currentController = controller

  const cvConfig = loadCosyVoiceConfig()
  if (!cvConfig.apiKey || !voiceId) return

  const wsUrl = getWsUrl(cvConfig)
  if (wsUrl.includes('{WorkspaceId}')) return

  // 检查 MediaSource 是否支持流式播放
  const mimeType = 'audio/mpeg'
  const canStream = MediaSource.isTypeSupported(mimeType)

  if (!canStream) {
    // 不支持流式 → 回退到批处理
    console.info('[TTS] 当前环境不支持 MediaSource 流式播放，回退到批处理模式')
    return speakText(text, voiceId)
  }

  try {
    await playStream(controller, cvConfig.model, voiceId, text, wsUrl, mimeType)
  } catch (err) {
    console.warn('[TTS] 流式播报失败:', err)
  } finally {
    if (currentController === controller) {
      currentController = null
    }
  }
}

/**
 * 流式播放核心：通过 Rust 后端启动物流合成，逐帧通过 Tauri event 回传，
 * 前端用 MediaSource + SourceBuffer 渐进式追加播放
 */
async function playStream(
  controller: AbortController,
  model: string,
  voice: string,
  text: string,
  wsUrl: string,
  mimeType: string,
): Promise<void> {
  const cvConfig = loadCosyVoiceConfig()

  // 创建 MediaSource
  const mediaSource = new MediaSource()
  const audio = new Audio()
  const blobUrl = URL.createObjectURL(mediaSource)
  audio.src = blobUrl

  // 等待 MediaSource 打开，创建 SourceBuffer
  const sourceBuffer = await new Promise<SourceBuffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MediaSource 打开超时')), 5000)
    mediaSource.onsourceopen = () => {
      clearTimeout(timeout)
      try {
        const sb = mediaSource.addSourceBuffer(mimeType)
        resolve(sb)
      } catch (e) {
        reject(new Error(`添加 SourceBuffer 失败: ${e}`))
      }
    }
  })

  if (controller.signal.aborted) {
    cleanupMediaSource(mediaSource, blobUrl, audio)
    return
  }

  // 音频块队列（SourceBuffer busy 时暂存）
  const pendingChunks: ArrayBuffer[] = []
  let streamError: string | null = null
  let firstChunkAppended = false

  // 等待所有帧处理完毕的信号（由 listen 回调在收到 is_last 时触发）
  let resolveStreamComplete: (() => void) | null = null
  const streamComplete = new Promise<void>((resolve) => {
    resolveStreamComplete = resolve
  })

  // SourceBuffer 空闲时尝试出队追加
  function flushBuffer() {
    if (sourceBuffer.updating || pendingChunks.length === 0) return
    const chunk = pendingChunks.shift()!
    sourceBuffer.appendBuffer(chunk)
  }

  sourceBuffer.addEventListener('updateend', () => {
    flushBuffer()
  })

  // 监听 Rust 后端推送的音频块
  const unlisten = await listen<TtsChunk>('tts-audio-chunk', (event) => {
    if (controller.signal.aborted || streamError) return

    if (event.payload.is_last) {
      resolveStreamComplete?.()
      flushBuffer()
      return
    }

    // Base64 → ArrayBuffer
    try {
      const binaryStr = atob(event.payload.data)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      pendingChunks.push(bytes.buffer as ArrayBuffer)
      flushBuffer()

      // 首个块追加后开始播放
      if (!firstChunkAppended) {
        firstChunkAppended = true
        audio.play().catch(() => {})
      }
    } catch {
      // 跳过损坏的音频块
    }
  })

  // 启动 Rust 后端流式合成
  const invokePromise = invoke('cosyvoice_tts_stream', {
    apiKey: cvConfig.apiKey,
    model,
    voice,
    text,
    wsUrl,
  })

  // 等待合成完成或出错
  try {
    await invokePromise
  } catch (err) {
    streamError = (err as Error).message
  }

  if (!controller.signal.aborted && !streamError) {
    // ===== 关键修复 =====
    // 等待 listen 回调确实收到了 is_last 事件（不能依赖 invokePromise 完成，
    // 因为 Tauri event 可能比 invoke 返回更晚到达前端）
    await streamComplete

    // 等待 SourceBuffer 消化完所有排队块
    await new Promise<void>((resolve) => {
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

    // 结束 MediaSource
    if (mediaSource.readyState === 'open') {
      try { mediaSource.endOfStream() } catch { /* ignore */ }
    }

    // 等待音频播完（设置超时防止永久挂起）
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve()
      audio.onerror = () => resolve()
      // 安全超时：按文本长度估算最大播放时长（每字符~100ms + 5s 余量）
      const estimatedMs = Math.min(text.length * 100 + 5000, 30000)
      setTimeout(() => {
        audio.pause()
        resolve()
      }, estimatedMs)
    })
  }

  // 取消监听（必须先于 cleanup，否则 is_last 可能还在路上）
  unlisten()

  cleanupMediaSource(mediaSource, blobUrl, audio)
}

/** 清理 MediaSource 资源 */
function cleanupMediaSource(mediaSource: MediaSource, blobUrl: string, audio: HTMLAudioElement) {
  try {
    audio.pause()
    audio.src = ''
    if (mediaSource.readyState !== 'closed') {
      try { mediaSource.endOfStream() } catch { /* ignore */ }
    }
    URL.revokeObjectURL(blobUrl)
  } catch { /* ignore */ }
}

/** 取消当前播报 */
export function cancelSpeak() {
  if (currentController) {
    currentController.abort()
    currentController = null
  }
}

/** 检查是否正在播报 */
export function isSpeaking(): boolean {
  return currentController !== null
}

interface TtsCommandResult {
  audio_base64: string
  format: string
}

/** 通过 HTMLAudioElement 播放 base64 音频 */
function playAudio(base64Data: string, format: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
      const byteChars = atob(base64Data)
      const byteArrays: Uint8Array[] = []

      for (let offset = 0; offset < byteChars.length; offset += 512) {
        const slice = byteChars.slice(offset, offset + 512)
        const bytes = new Uint8Array(slice.length)
        for (let i = 0; i < slice.length; i++) {
          bytes[i] = slice.charCodeAt(i)
        }
        byteArrays.push(bytes)
      }

      const blob = new Blob(byteArrays, { type: mimeType })
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
      })

      audio.play().catch((err) => {
        URL.revokeObjectURL(url)
        reject(err)
      })
    } catch (err) {
      reject(err)
    }
  })
}
