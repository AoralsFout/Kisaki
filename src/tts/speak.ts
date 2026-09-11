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
import { loadCosyVoiceConfigSecure, getWsUrl, getTtsProvider, loadGptSoVitsConfig } from './config'
import { buildGptSoVitsStreamUrl, PcmStreamPlayer } from './gptsovits'
import { createLogger } from '../utils/logger'
import { STORAGE_TTS_ENABLED } from '../constants'
import type { AudioSource, TtsProvider } from '../application/tts/ttsProvider'
import { selectAudioSink, type AudioSink } from '../application/tts/audioSink'
import { HtmlAudioSink } from './sinks/htmlAudioSink'
import { Live2DLipSyncSink, type VoicePlayer } from './sinks/live2DLipSyncSink'
import { CosyVoiceProvider } from './providers/cosyVoiceProvider'
import { GptSoVitsProvider } from './providers/gptSoVitsProvider'
import { loadGptSoVitsCharacterParams } from './characterVoiceProfile'
import type {
  TtsPlaybackHooks,
  TtsPlaybackResult,
} from '../application/tts/ttsPlaybackOrchestrator'

export type {
  TtsPlaybackHooks,
  TtsPlaybackResult,
  TtsPlaybackStatus,
} from '../application/tts/ttsPlaybackOrchestrator'

export type { VoicePlayer } from './sinks/live2DLipSyncSink'

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

// ============================================================
//  TtsEngine 类 — 封装所有 TTS 状态（原模块级 currentController）
// ============================================================

export class TtsEngine {
  private currentController: AbortController | null = null
  /** 流序号，用于为每次流式播报生成唯一 stream_id（过滤旧流音频帧） */
  private streamSeq = 0
  /** Live2D 口型播放钩子；注册后 TTS 改走"批合成 → blob → playVoice（带口型）" */
  private voicePlayer: VoicePlayer | null = null
  /** 以稳定 key 去重当前实例的连续配置警告。 */
  private configSkipKeys = new Set<string>()
  private readonly providers: ReadonlyMap<TtsProvider['id'], TtsProvider>
  /** 音频输出实现按能力排序；首个 canPlay 命中的 Sink 负责本次播放。 */
  private readonly sinks: readonly AudioSink[]

  constructor(
    providers: readonly TtsProvider[] = [new CosyVoiceProvider(), new GptSoVitsProvider()],
    sinks?: readonly AudioSink[],
  ) {
    this.providers = new Map(providers.map(provider => [provider.id, provider]))
    if (sinks) {
      this.sinks = sinks
    } else {
      const htmlAudio = new HtmlAudioSink()
      this.sinks = [new Live2DLipSyncSink(() => this.voicePlayer, htmlAudio), htmlAudio]
    }
  }

  /** 配置类跳过只 warn 一次（同 key），后续以 trace 记录，既不刷屏也保留可观测性。 */
  private warnOnce(skey: string, message: string) {
    if (this.configSkipKeys.has(skey)) {
      log.trace('tts.config_skip_repeat.trace', `重复跳过 TTS (${skey})`)
      return
    }
    this.configSkipKeys.add(skey)
    log.warn('tts.config_skip.warn', message)
  }

  private clearWarning(skey: string) {
    this.configSkipKeys.delete(skey)
  }

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
  async speakText(text: string, voiceId: string, hooks: TtsPlaybackHooks = {}): Promise<TtsPlaybackResult> {
    if (!text.trim()) return { status: 'skipped', reason: 'empty_text' }
    if (!this.isEnabled()) return { status: 'skipped', reason: 'disabled' }
    const provider = getTtsProvider()
    if (provider === 'none') return { status: 'skipped', reason: 'provider_none' }
    this.cancel()

    const controller = new AbortController()
    this.currentController = controller

    try {
      return await this.speakBuffered(provider, text, voiceId, controller, hooks)
    } catch (err) {
      log.warn("tts.speak_text.warn", "批处理播报失败", err)
      return {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        reason: (err as Error).message,
      }
    } finally {
      if (this.currentController === controller) {
        this.currentController = null
      }
    }
  }

  /** 合成并流式播报文本（边接收边播放，延迟更低） */
  async speakTextStreaming(text: string, voiceId: string, hooks: TtsPlaybackHooks = {}): Promise<TtsPlaybackResult> {
    if (!text.trim()) return { status: 'skipped', reason: 'empty_text' }
    if (!this.isEnabled()) return { status: 'skipped', reason: 'disabled' }
    const provider = getTtsProvider()
    if (provider === 'none') return { status: 'skipped', reason: 'provider_none' }
    this.cancel()

    const controller = new AbortController()
    this.currentController = controller

    if (provider === 'gptsovits') {
      // Live2D 角色暂不应用口型同步，统一走 PCM 流式输出（低延迟，无口型驱动）
      try {
        return await this.speakGptSoVitsStream(text, controller, hooks)
      } catch (error) {
        log.warn("tts.speak_gpt_so_vits_stream.warn", "GPT-SoVITS 流式播报失败", error)
        return { status: controller.signal.aborted ? 'cancelled' : 'failed', reason: (error as Error).message }
      } finally {
        if (this.currentController === controller) this.currentController = null
      }
    }

    // Live2D requires a buffered source so its player can drive lip sync.
    if (this.voicePlayer) {
      try {
        return await this.speakBuffered(provider, text, voiceId, controller, hooks)
      } catch (error) {
        log.warn('tts.speak_buffered_lip_sync.warn', '口型同步播报失败', error)
        return {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          reason: (error as Error).message,
        }
      } finally {
        if (this.currentController === controller) this.currentController = null
      }
    }

    // ── CosyVoice 流式处理 ──
    const cvConfig = await loadCosyVoiceConfigSecure()
    if (!cvConfig.apiKey || !voiceId) {
      if (this.currentController === controller) this.currentController = null
      return { status: 'skipped', reason: !cvConfig.apiKey ? 'missing_api_key' : 'missing_voice_id' }
    }

    const wsUrl = getWsUrl(cvConfig)
    if (wsUrl.includes('{WorkspaceId}')) {
      if (this.currentController === controller) this.currentController = null
      return { status: 'skipped', reason: 'missing_workspace_id' }
    }

    // 检查 MediaSource 是否支持流式播放
    const mimeType = 'audio/mpeg'
    const canStream = MediaSource.isTypeSupported(mimeType)

    if (!canStream) {
      log.info("tts.speak_text_streaming.info", "当前环境不支持 MediaSource 流式播放，回退到批处理模式")
      return this.speakText(text, voiceId, hooks)
    }

    try {
      hooks.onSynthesisStart?.()
      await this.playStream(controller, cvConfig.apiKey, cvConfig.model, voiceId, text, wsUrl, mimeType, hooks)
      return controller.signal.aborted ? { status: 'cancelled' } : { status: 'played' }
    } catch (err) {
      log.warn("tts.speak_text_streaming.warn", "流式播报失败", err)
      return { status: 'failed', reason: (err as Error).message }
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
    hooks: TtsPlaybackHooks,
  ): Promise<TtsPlaybackResult> {
    const config = loadGptSoVitsConfig()
    if (!config.apiUrl) {
      this.warnOnce('gptsovits.missing_api_url', 'GPT-SoVITS API URL 未配置，跳过 TTS')
      return { status: 'skipped', reason: 'missing_api_url' }
    }
    this.clearWarning('gptsovits.missing_api_url')

    const charParams = await loadGptSoVitsCharacterParams()
    if (!charParams.refAudioPath) {
      this.warnOnce('gptsovits.missing_ref_audio', 'GPT-SoVITS 参考音频路径未配置（请在角色编辑器中设置），跳过 TTS')
      return { status: 'skipped', reason: 'missing_ref_audio' }
    }
    this.clearWarning('gptsovits.missing_ref_audio')

    if (controller.signal.aborted) return { status: 'cancelled' }
    hooks.onSynthesisStart?.()

    const streamId = String(++this.streamSeq)
    const url = buildGptSoVitsStreamUrl(
      text,
      charParams.refAudioPath,
      charParams.textLang,
      charParams.promptText || undefined,
      charParams.promptLang || undefined,
    )

    log.debug("tts.speak_gpt_so_vits_stream.debug", `GPT-SoVITS 流式请求: stream_id=${streamId}`, { stream_id: streamId })

    // Web Audio 连续 PCM 播放器：收到字节即排程播放，无缝衔接、低延迟
    const player = new PcmStreamPlayer()
    let streamError: string | null = null
    let receivedAudioBytes = 0
    let firstAudioReported = false

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
        receivedAudioBytes += bytes.byteLength
        if (!firstAudioReported && receivedAudioBytes > 44) {
          firstAudioReported = true
          hooks.onFirstAudio?.()
        }
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
        if (receivedAudioBytes <= 44) {
          streamError = 'GPT-SoVITS 未返回可播放音频'
        }
        player.end()
        if (!streamError) {
          await Promise.race([
            player.waitDone(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GPT-SoVITS 播放超时')), 60000)),
          ])
        }
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
      log.warn("tts.speak_gpt_so_vits_stream.warn", `GPT-SoVITS 流式合成失败: ${streamError}`, streamError)
      return { status: 'failed', reason: streamError }
    }
    return controller.signal.aborted ? { status: 'cancelled' } : { status: 'played' }
  }

  private async speakBuffered(
    providerId: TtsProvider['id'],
    text: string,
    voiceId: string,
    controller: AbortController,
    hooks: TtsPlaybackHooks,
  ): Promise<TtsPlaybackResult> {
    const provider = this.providers.get(providerId)
    if (!provider) return { status: 'failed', reason: `unsupported_provider:${providerId}` }
    const synthesis = await provider.synthesize(
      { text, voiceId },
      { signal: controller.signal, onSynthesisStart: hooks.onSynthesisStart },
    )
    if (synthesis.status === 'skipped') return synthesis
    if (synthesis.status === 'cancelled' || controller.signal.aborted) return { status: 'cancelled' }
    await this.playBufferedSource(synthesis.source, controller.signal, hooks.onFirstAudio)
    return controller.signal.aborted ? { status: 'cancelled' } : { status: 'played' }
  }

  private async playBufferedSource(
    source: AudioSource,
    signal: AbortSignal,
    onFirstAudio?: () => void,
  ): Promise<void> {
    const sink = selectAudioSink(this.sinks, source)
    await sink.play(source, { signal, onFirstAudio })
  }

  /**
   * 流式播放核心：通过 Rust 后端启动物流合成，逐帧通过 Tauri event 回传，
   * 前端用 MediaSource + SourceBuffer 渐进式追加播放
   */
  private async playStream(
    controller: AbortController,
    apiKey: string,
    model: string,
    voice: string,
    text: string,
    wsUrl: string,
    mimeType: string,
    hooks: TtsPlaybackHooks,
  ): Promise<void> {
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
      let audioPlayPromise: Promise<void> | null = null

      let resolveStreamComplete: (() => void) | null = null
      const streamComplete = new Promise<void>((resolve) => {
        resolveStreamComplete = resolve
      })

      const flushBuffer = () => {
        if (sourceBuffer.updating || pendingChunks.length === 0 || streamError) return
        try {
          const chunk = pendingChunks.shift()!
          sourceBuffer.appendBuffer(chunk)
        } catch (error) {
          streamError = (error as Error).message || '追加音频缓冲失败'
          resolveStreamComplete?.()
        }
      }

      sourceBuffer.addEventListener('updateend', () => { flushBuffer() })
      sourceBuffer.addEventListener('error', () => {
        streamError = '音频缓冲解码失败'
        resolveStreamComplete?.()
      })

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
            audioPlayPromise = audio.play()
              .then(() => { hooks.onFirstAudio?.() })
              .catch((error) => {
                streamError = (error as Error).message || '音频播放启动失败'
                resolveStreamComplete?.()
              })
          }
        } catch (error) {
          streamError = (error as Error).message || '音频块解码失败'
          resolveStreamComplete?.()
        }
      })

      const invokePromise = invoke('cosyvoice_tts_stream', {
        streamId, apiKey, model, voice, text, wsUrl,
      })

      try { await invokePromise } catch (err) { streamError = (err as Error).message }

      if (!controller.signal.aborted && !streamError) {
        // 等待全部音频帧追加完成；安全超时兜底，即便后端漏发 is_last 也不会无限等待
        await Promise.race([
          streamComplete,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等待 TTS 音频流超时')), 60000)),
        ])
        if (!firstChunkAppended || !audioPlayPromise) throw new Error('TTS 未返回可播放音频')
        await audioPlayPromise
        if (streamError) throw new Error(streamError)
        await Promise.race([new Promise<void>((resolve) => {
          if (!sourceBuffer.updating && pendingChunks.length === 0) { resolve(); return }
          const onUpdateEnd = () => {
            if (!sourceBuffer.updating && pendingChunks.length === 0) {
              sourceBuffer.removeEventListener('updateend', onUpdateEnd)
              resolve()
            }
          }
          sourceBuffer.addEventListener('updateend', onUpdateEnd)
        }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('刷新 TTS 音频缓冲超时')), 10000))])
        if (streamError) throw new Error(streamError)
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream() } catch { /* ignore */ }
        }
        await new Promise<void>((resolve, reject) => {
          let settled = false
          let timeout: ReturnType<typeof setTimeout> | null = null
          const onAbort = () => finish()
          const finish = (error?: Error) => {
            if (settled) return
            settled = true
            if (timeout !== null) clearTimeout(timeout)
            controller.signal.removeEventListener('abort', onAbort)
            error ? reject(error) : resolve()
          }
          audio.onended = () => finish()
          audio.onerror = () => finish(new Error('TTS 音频播放失败'))
          const estimatedMs = Math.min(text.length * 100 + 5000, 30000)
          timeout = setTimeout(() => {
            audio.pause()
            finish(new Error('TTS 音频播放超时'))
          }, estimatedMs)
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        })
      }
      if (streamError) throw new Error(streamError)
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
        try { mediaSource.endOfStream() } catch (e) { log.warn("tts.cleanup_media_source.warn", "MediaSource endOfStream 失败", e) }
      }
      URL.revokeObjectURL(blobUrl)
    } catch (e) { log.warn("tts.cleanup_media_source.warn", "清理 MediaSource 资源失败", e) }
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
export function speakText(text: string, voiceId: string, hooks?: TtsPlaybackHooks): Promise<TtsPlaybackResult> { return ttsEngine.speakText(text, voiceId, hooks) }
/** 合成并流式播报文本 */
export function speakTextStreaming(text: string, voiceId: string, hooks?: TtsPlaybackHooks): Promise<TtsPlaybackResult> { return ttsEngine.speakTextStreaming(text, voiceId, hooks) }
/** 取消当前播报 */
export function cancelSpeak() { ttsEngine.cancel() }
/** 检查是否正在播报 */
export function isSpeaking(): boolean { return ttsEngine.isSpeaking() }
/** 注册/注销 Live2D 口型播放器 */
export function setVoicePlayer(fn: VoicePlayer | null) { ttsEngine.setVoicePlayer(fn) }
