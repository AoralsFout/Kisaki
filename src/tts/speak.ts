/**
 * CosyVoice & GPT-SoVITS TTS 播报服务
 *
 * 封装为 TtsEngine 类，消除模块级可变状态。
 * 导出单例 ttsEngine 供正常使用，也支持创建独立实例用于测试。
 *
 * 支持两种模式：
 *   1. speakText — 批处理模式（等全部合成完再播放）
 *   2. speakTextStreaming — 流式模式（边合成边播放）
 *
 * 根据 localStorage 中的 TTS 提供者设置自动切换：
 *   - 'cosyvoice' → 通过 Rust 后端调用阿里云 CosyVoice WebSocket API
 *   - 'gptsovits' → 通过 HTTP 调用本地 GPT-SoVITS API
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { loadCosyVoiceConfig, getWsUrl, getTtsProvider, loadGptSoVitsConfig } from './config'
import { synthesizeWithGptSoVits, playAudioBlob, buildGptSoVitsStreamUrl, PcmStreamPlayer } from './gptsovits'
import { createLogger } from '../utils/logger'
import { STORAGE_TTS_ENABLED, DEFAULT_VOICE_LANGUAGE } from '../constants'

const log = createLogger('TTS')

/** TTS 存储 key */
const ENABLED_KEY = STORAGE_TTS_ENABLED

/** 流式音频帧事件结构（对应 Rust TtsChunk） */
interface TtsChunk {
  stream_id: string
  data: string
  format: string
  is_last: boolean
}

interface TtsCommandResult {
  audio_base64: string
  format: string
}

/** Live2D 口型播放器：播放给定音频 URL 并驱动模型口型；signal 中止即停。 */
export type VoicePlayer = (audioUrl: string, signal: AbortSignal) => Promise<void>

// ============================================================
//  TtsEngine 类 — 封装所有 TTS 状态（原模块级 currentController）
// ============================================================

export class TtsEngine {
  private currentController: AbortController | null = null
  /** 流序号，用于为每次流式播报生成唯一 stream_id（过滤旧流音频帧） */
  private streamSeq = 0
  /** Live2D 口型播放钩子；注册后 TTS 改走"批合成 → blob → playVoice（带口型）" */
  private voicePlayer: VoicePlayer | null = null

  /** 注册/注销 Live2D 口型播放器（Live2DStage 在模型 ready/卸载时调用） */
  setVoicePlayer(fn: VoicePlayer | null) {
    this.voicePlayer = fn
  }

  /** 语音播报是否开启 */
  isEnabled(): boolean {
    try {
      return localStorage.getItem(ENABLED_KEY) !== 'false'
    } catch {
      return true
    }
  }

  /** 设置语音播报开关 */
  setEnabled(enabled: boolean) {
    localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false')
  }

  /** 取消当前播报 */
  cancel() {
    if (this.currentController) {
      this.currentController.abort()
      this.currentController = null
    }
  }

  /** 检查是否正在播报 */
  isSpeaking(): boolean {
    return this.currentController !== null
  }

  /** 合成并播报文本（批处理模式） */
  async speakText(text: string, voiceId: string): Promise<void> {
    if (!this.isEnabled()) return
    const provider = getTtsProvider()
    if (provider === 'none') return
    this.cancel()

    const controller = new AbortController()
    this.currentController = controller

    if (provider === 'gptsovits') {
      await this.speakWithGptSoVits(text, controller)
      return
    }

    // ── CosyVoice 批处理 ──
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
      await this.playAudio(result.audio_base64, result.format, controller.signal)
    } catch (err) {
      log.warn('批处理播报失败', err)
    } finally {
      if (this.currentController === controller) {
        this.currentController = null
      }
    }
  }

  /** 合成并流式播报文本（边接收边播放，延迟更低） */
  async speakTextStreaming(text: string, voiceId: string): Promise<void> {
    if (!this.isEnabled()) return
    const provider = getTtsProvider()
    if (provider === 'none') return
    this.cancel()

    const controller = new AbortController()
    this.currentController = controller

    if (provider === 'gptsovits') {
      // Live2D 角色暂不应用口型同步，统一走 PCM 流式输出（低延迟，无口型驱动）
      await this.speakGptSoVitsStream(text, controller)
      return
    }

    // ── CosyVoice 流式处理 ──
    const cvConfig = loadCosyVoiceConfig()
    if (!cvConfig.apiKey || !voiceId) return

    const wsUrl = getWsUrl(cvConfig)
    if (wsUrl.includes('{WorkspaceId}')) return

    // Live2D 口型：注册了 voicePlayer 时走批合成 → blob → playVoice（带口型），不走流式
    if (this.voicePlayer) {
      try {
        await this.speakBatchWithLipSync(text, voiceId, cvConfig, wsUrl, controller)
      } finally {
        if (this.currentController === controller) this.currentController = null
      }
      return
    }

    // 检查 MediaSource 是否支持流式播放
    const mimeType = 'audio/mpeg'
    const canStream = MediaSource.isTypeSupported(mimeType)

    if (!canStream) {
      log.info('当前环境不支持 MediaSource 流式播放，回退到批处理模式')
      return this.speakText(text, voiceId)
    }

    try {
      await this.playStream(controller, cvConfig.model, voiceId, text, wsUrl, mimeType)
    } catch (err) {
      log.warn('流式播报失败', err)
    } finally {
      if (this.currentController === controller) {
        this.currentController = null
      }
    }
  }

  /**
   * GPT-SoVITS 流式合成：Rust 逐 chunk → Tauri event → 前端 Web Audio 连续 PCM 播放
   *
   * 服务端返回 [44字节WAV头][裸PCM...] 单条连续流，网络分片边界任意，
   * 故不能把每个 chunk 当独立音频文件播；交由 PcmStreamPlayer 重组并无缝排程。
   */
  private async speakGptSoVitsStream(
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const config = loadGptSoVitsConfig()
    if (!config.apiUrl) {
      log.warn('GPT-SoVITS API URL 未配置，跳过 TTS')
      return
    }

    const charParams = await this.getGptSoVitsCharacterParams()
    if (!charParams.refAudioPath) {
      log.warn('GPT-SoVITS 参考音频路径未配置（请在角色编辑器中设置），跳过 TTS')
      return
    }

    if (controller.signal.aborted) return

    const streamId = String(++this.streamSeq)
    const url = buildGptSoVitsStreamUrl(
      text,
      charParams.refAudioPath,
      charParams.textLang,
      charParams.promptText || undefined,
      charParams.promptLang || undefined,
    )

    log.debug('GPT-SoVITS 流式请求: stream_id=%s', streamId)

    // Web Audio 连续 PCM 播放器：收到字节即排程播放，无缝衔接、低延迟
    const player = new PcmStreamPlayer()
    let streamError: string | null = null

    const onAbort = () => player.dispose()
    controller.signal.addEventListener('abort', onAbort, { once: true })

    const unlisten = await listen<TtsChunk>('tts-audio-chunk', (event) => {
      if (event.payload.stream_id !== streamId) return
      if (controller.signal.aborted || streamError) return

      if (event.payload.is_last) {
        player.end()
        return
      }

      try {
        const binaryStr = atob(event.payload.data)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        player.push(bytes)
      } catch { /* 跳过损坏块 */ }
    })

    try {
      await invoke('gptsovits_tts_stream', { streamId, url })
    } catch (err) {
      streamError = (err as Error).message
    }

    try {
      // 后端命令返回 = 字节已全部发完；标记结束并等待已排程音频播放完毕。
      // 安全超时兜底，即便漏发 is_last 也不会无限等待。
      if (!controller.signal.aborted && !streamError) {
        player.end()
        await Promise.race([
          player.waitDone(),
          new Promise<void>((resolve) => setTimeout(resolve, 60000)),
        ])
      }
    } finally {
      unlisten()
      controller.signal.removeEventListener('abort', onAbort)
      player.dispose()
      if (this.currentController === controller) {
        this.currentController = null
      }
    }

    if (streamError) {
      log.warn('GPT-SoVITS 流式合成失败: %s', streamError)
    }
  }

  /**
   * GPT-SoVITS 批合成：加载配置、获取角色级参数、调用 HTTP API、播放
   */
  private async speakWithGptSoVits(
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const config = loadGptSoVitsConfig()
    if (!config.apiUrl) {
      log.warn('GPT-SoVITS API URL 未配置，跳过 TTS')
      return
    }

    // 获取角色级参数（参考音频必须从角色数据获取）
    const charParams = await this.getGptSoVitsCharacterParams()
    if (!charParams.refAudioPath) {
      log.warn('GPT-SoVITS 参考音频路径未配置（请在角色编辑器中设置），跳过 TTS')
      return
    }

    if (controller.signal.aborted) return

    try {
      const result = await synthesizeWithGptSoVits({
        text,
        refAudioPath: charParams.refAudioPath,
        promptText: charParams.promptText || undefined,
        promptLang: charParams.promptLang || undefined,
        textLang: charParams.textLang,
      })

      if (controller.signal.aborted) return

      // Live2D 口型：走 voicePlayer
      if (this.voicePlayer) {
        const url = URL.createObjectURL(result.blob)
        try {
          await this.voicePlayer(url, controller.signal)
        } catch {
          log.warn('playVoice 口型播放失败，回退 HTMLAudio')
          if (!controller.signal.aborted) {
            await playAudioBlob(result.blob, controller.signal)
          }
        } finally {
          URL.revokeObjectURL(url)
        }
      } else {
        await playAudioBlob(result.blob, controller.signal)
      }
    } catch (err) {
      log.warn('GPT-SoVITS 合成/播放失败: %s', (err as Error).message)
    } finally {
      if (this.currentController === controller) {
        this.currentController = null
      }
    }
  }

  /**
   * 从当前角色数据中提取 GPT-SoVITS 参数
   * 角色级字段覆盖全局默认值
   */
  private async getGptSoVitsCharacterParams(): Promise<{
    refAudioPath: string
    promptText: string
    promptLang: string
    textLang: string
  }> {
    try {
      // 惰性获取 Pinia store（使用 getActivePinia 避免循环依赖）
      const { getActivePinia } = await import('pinia')
      const pinia = getActivePinia()
      if (pinia) {
        const { useCharacterStore } = await import('../stores/character')
        const store = useCharacterStore(pinia)
        const data = store.data
        if (data) {
          return {
            refAudioPath: (data as any).gptsovitsRefAudio || '',
            promptText: (data as any).gptsovitsPromptText || '',
            promptLang: (data as any).gptsovitsPromptLang || '',
            textLang: data.voiceLanguage || DEFAULT_VOICE_LANGUAGE,
          }
        }
      }
    } catch {
      // Pinia store 不可用时（非 Tauri/测试环境）返回空值
    }
    return { refAudioPath: '', promptText: '', promptLang: '', textLang: DEFAULT_VOICE_LANGUAGE }
  }

  /**
   * Live2D 口型：批合成完整音频 → blob URL → voicePlayer（playVoice 带口型）。
   * playVoice 失败时回退到 HTMLAudio 播放（有声音、无口型）。
   */
  private async speakBatchWithLipSync(
    text: string,
    voiceId: string,
    cvConfig: ReturnType<typeof loadCosyVoiceConfig>,
    wsUrl: string,
    controller: AbortController,
  ): Promise<void> {
    let result: TtsCommandResult
    try {
      result = await invoke<TtsCommandResult>('cosyvoice_tts', {
        apiKey: cvConfig.apiKey, model: cvConfig.model, voice: voiceId, text, wsUrl,
      })
    } catch (err) {
      log.warn('口型合成失败', err)
      return
    }
    if (controller.signal.aborted) return

    const mimeType = result.format === 'mp3' ? 'audio/mpeg' : `audio/${result.format}`
    const binaryStr = atob(result.audio_base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    try {
      await this.voicePlayer!(url, controller.signal)
    } catch (err) {
      log.warn('playVoice 口型播放失败，回退 HTMLAudio', err)
      if (!controller.signal.aborted) await this.playAudio(result.audio_base64, result.format, controller.signal)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /**
   * 流式播放核心：通过 Rust 后端启动物流合成，逐帧通过 Tauri event 回传，
   * 前端用 MediaSource + SourceBuffer 渐进式追加播放
   */
  private async playStream(
    controller: AbortController,
    model: string,
    voice: string,
    text: string,
    wsUrl: string,
    mimeType: string,
  ): Promise<void> {
    const cvConfig = loadCosyVoiceConfig()

    // 本次流的唯一 id：后端会在每个音频帧里带上它，前端据此过滤掉
    // 已被取代的旧流的帧，避免快速连发消息时新旧音频串台。
    const streamId = String(++this.streamSeq)

    const mediaSource = new MediaSource()
    const audio = new Audio()
    const blobUrl = URL.createObjectURL(mediaSource)
    audio.src = blobUrl

    // 用 finally 兜底回收 MediaSource / blobUrl / Audio / unlisten，避免任何
    // 提前返回或异常路径（SourceBuffer 打开失败、listen 失败等）泄漏资源。
    let unlisten: (() => void) | null = null
    try {
      // 取消时立即暂停播放（后端任务会因 30s 读超时或服务端结束而自行收尾）
      controller.signal.addEventListener('abort', () => {
        try { audio.pause() } catch { /* ignore */ }
      }, { once: true })

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

      if (controller.signal.aborted) return

      const pendingChunks: ArrayBuffer[] = []
      let streamError: string | null = null
      let firstChunkAppended = false

      let resolveStreamComplete: (() => void) | null = null
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve
      })

      const flushBuffer = () => {
        if (sourceBuffer.updating || pendingChunks.length === 0) return
        const chunk = pendingChunks.shift()!
        sourceBuffer.appendBuffer(chunk)
      }

      sourceBuffer.addEventListener('updateend', () => { flushBuffer() })

      unlisten = await listen<TtsChunk>('tts-audio-chunk', (event) => {
        // 过滤掉非本次流（已被取代的旧流）的音频帧
        if (event.payload.stream_id !== streamId) return
        if (controller.signal.aborted || streamError) return
        if (event.payload.is_last) {
          resolveStreamComplete?.()
          flushBuffer()
          return
        }
        try {
          const binaryStr = atob(event.payload.data)
          const bytes = new Uint8Array(binaryStr.length)
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
          pendingChunks.push(bytes.buffer as ArrayBuffer)
          flushBuffer()
          if (!firstChunkAppended) {
            firstChunkAppended = true
            audio.play().catch(e => log.warn('音频播放启动失败', e))
          }
        } catch { /* 跳过损坏块 */ }
      })

      const invokePromise = invoke('cosyvoice_tts_stream', {
        streamId, apiKey: cvConfig.apiKey, model, voice, text, wsUrl,
      })

      try { await invokePromise } catch (err) { streamError = (err as Error).message }

      if (!controller.signal.aborted && !streamError) {
        // 等待全部音频帧追加完成；安全超时兜底，即便后端漏发 is_last 也不会无限等待
        await Promise.race([
          streamComplete,
          new Promise<void>((resolve) => setTimeout(resolve, 60000)),
        ])
        await new Promise<void>((resolve) => {
          if (!sourceBuffer.updating && pendingChunks.length === 0) { resolve(); return }
          const onUpdateEnd = () => {
            if (!sourceBuffer.updating && pendingChunks.length === 0) {
              sourceBuffer.removeEventListener('updateend', onUpdateEnd)
              resolve()
            }
          }
          sourceBuffer.addEventListener('updateend', onUpdateEnd)
        })
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream() } catch { /* ignore */ }
        }
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          const estimatedMs = Math.min(text.length * 100 + 5000, 30000)
          setTimeout(() => { audio.pause(); resolve() }, estimatedMs)
        })
      }
    } finally {
      unlisten?.()
      this.cleanupMediaSource(mediaSource, blobUrl, audio)
    }
  }

  /** 清理 MediaSource 资源 */
  private cleanupMediaSource(mediaSource: MediaSource, blobUrl: string, audio: HTMLAudioElement) {
    try {
      audio.pause()
      audio.src = ''
      if (mediaSource.readyState !== 'closed') {
        try { mediaSource.endOfStream() } catch (e) { log.warn('MediaSource endOfStream 失败', e) }
      }
      URL.revokeObjectURL(blobUrl)
    } catch (e) { log.warn('清理 MediaSource 资源失败', e) }
  }

  /** 通过 HTMLAudioElement 播放 base64 音频 */
  private playAudio(base64Data: string, format: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
        const byteChars = atob(base64Data)
        const byteArrays: Uint8Array[] = []
        for (let offset = 0; offset < byteChars.length; offset += 512) {
          const slice = byteChars.slice(offset, offset + 512)
          const bytes = new Uint8Array(slice.length)
          for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i)
          byteArrays.push(bytes)
        }
        const blob = new Blob(byteArrays, { type: mimeType })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.onended = () => { URL.revokeObjectURL(url); resolve() }
        audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('音频播放失败')) }
        if (signal.aborted) { audio.pause(); audio.src = ''; URL.revokeObjectURL(url); resolve(); return }
        signal.addEventListener('abort', () => { audio.pause(); audio.src = ''; URL.revokeObjectURL(url); resolve() })
        audio.play().catch((err) => { URL.revokeObjectURL(url); reject(err) })
      } catch (err) { reject(err) }
    })
  }
}

// ============================================================
//  默认单例 — 向后兼容的模块级 API
// ============================================================

export const ttsEngine = new TtsEngine()

/** 语音播报是否开启 */
export function isTtsEnabled(): boolean { return ttsEngine.isEnabled() }
/** 设置语音播报开关 */
export function setTtsEnabled(enabled: boolean) { ttsEngine.setEnabled(enabled) }
/** 合成并播报文本（批处理模式） */
export function speakText(text: string, voiceId: string): Promise<void> { return ttsEngine.speakText(text, voiceId) }
/** 合成并流式播报文本 */
export function speakTextStreaming(text: string, voiceId: string): Promise<void> { return ttsEngine.speakTextStreaming(text, voiceId) }
/** 取消当前播报 */
export function cancelSpeak() { ttsEngine.cancel() }
/** 检查是否正在播报 */
export function isSpeaking(): boolean { return ttsEngine.isSpeaking() }
/** 注册/注销 Live2D 口型播放器 */
export function setVoicePlayer(fn: VoicePlayer | null) { ttsEngine.setVoicePlayer(fn) }
