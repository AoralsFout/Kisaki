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
import { getTtsProvider } from './config'
import { createLogger } from '../utils/logger'
import { STORAGE_TTS_ENABLED } from '../constants'
import type { AudioSource, TtsProvider } from '../application/tts/ttsProvider'
import { findAudioSink, selectAudioSink, type AudioSink } from '../application/tts/audioSink'
import { HtmlAudioSink } from './sinks/htmlAudioSink'
import { Live2DLipSyncSink, type VoicePlayer } from './sinks/live2DLipSyncSink'
import { MediaSourceStreamSink } from './sinks/mediaSourceStreamSink'
import { PcmStreamSink } from './sinks/pcmStreamSink'
import { CosyVoiceProvider } from './providers/cosyVoiceProvider'
import { GptSoVitsProvider } from './providers/gptSoVitsProvider'
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

// ============================================================
//  TtsEngine 类 — 封装所有 TTS 状态（原模块级 currentController）
// ============================================================

export interface TtsEngineOptions {
  sinks?: readonly AudioSink[]
  /** 当某个已注册 Sink 需要完整音频文件（如 Live2D 口型）时返回 true。 */
  preferBuffered?: () => boolean
}

/** 配置类跳过原因 → 一次性告警文案；同一原因在成功前只提醒一次。 */
const CONFIG_SKIP_MESSAGES: Record<string, string> = {
  missing_api_key: 'CosyVoice API Key 未配置，跳过 TTS',
  missing_workspace_id: 'CosyVoice 新加坡地域缺少 WorkspaceId，跳过 TTS',
  missing_api_url: 'GPT-SoVITS API URL 未配置，跳过 TTS',
  missing_ref_audio: 'GPT-SoVITS 参考音频路径未配置（请在角色编辑器中设置），跳过 TTS',
}

export class TtsEngine {
  private currentController: AbortController | null = null
  /** Live2D 口型播放钩子；注册后 TTS 改走"批合成 → blob → playVoice（带口型）" */
  private voicePlayer: VoicePlayer | null = null
  /** 以稳定 key 去重当前实例的连续配置警告。 */
  private configSkipKeys = new Set<string>()
  private readonly providers: ReadonlyMap<TtsProvider['id'], TtsProvider>
  /** 音频输出实现按能力排序；首个 canPlay 命中的 Sink 负责本次播放。 */
  private readonly sinks: readonly AudioSink[]
  private readonly preferBuffered: () => boolean

  constructor(
    providers: readonly TtsProvider[] = [new CosyVoiceProvider(), new GptSoVitsProvider()],
    options: TtsEngineOptions = {},
  ) {
    this.providers = new Map(providers.map(provider => [provider.id, provider]))
    this.preferBuffered = options.preferBuffered ?? (() => this.voicePlayer !== null)
    if (options.sinks) {
      this.sinks = options.sinks
    } else {
      const htmlAudio = new HtmlAudioSink()
      this.sinks = [
        new Live2DLipSyncSink(() => this.voicePlayer, htmlAudio),
        htmlAudio,
        new MediaSourceStreamSink(),
        new PcmStreamSink(),
      ]
    }
  }

  /** 配置类跳过只 warn 一次（同 key），后续以 trace 记录，既不刷屏也保留可观测性。 */
  private reportSkip(result: { status: 'skipped'; reason: string }): TtsPlaybackResult {
    const message = CONFIG_SKIP_MESSAGES[result.reason]
    if (!message) return result
    if (this.configSkipKeys.has(result.reason)) {
      log.trace('tts.config_skip_repeat.trace', `重复跳过 TTS (${result.reason})`)
      return result
    }
    this.configSkipKeys.add(result.reason)
    log.warn('tts.config_skip.warn', message)
    return result
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

  /** 合成并流式播报文本（边接收边播放，延迟更低） */
  async speakTextStreaming(text: string, voiceId: string, hooks: TtsPlaybackHooks = {}): Promise<TtsPlaybackResult> {
    if (!text.trim()) return { status: 'skipped', reason: 'empty_text' }
    if (!this.isEnabled()) return { status: 'skipped', reason: 'disabled' }
    const providerId = getTtsProvider()
    if (providerId === 'none') return { status: 'skipped', reason: 'provider_none' }
    this.cancel()

    const controller = new AbortController()
    this.currentController = controller

    try {
      return await this.playStreaming(providerId, text, voiceId, controller, hooks)
    } catch (error) {
      log.warn('tts.speak_text_streaming.warn', '流式播报失败', error)
      return {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        reason: (error as Error).message,
      }
    } finally {
      if (this.currentController === controller) {
        this.currentController = null
      }
    }
  }

  /**
   * 流式路径：先让 Provider 产出 StreamedAudioSource，再挑选能消费该格式的 Sink。
   * Provider 不支持流式、或当前环境没有任何 Sink 能播放该格式时，回退到批合成。
   */
  private async playStreaming(
    providerId: TtsProvider['id'],
    text: string,
    voiceId: string,
    controller: AbortController,
    hooks: TtsPlaybackHooks,
  ): Promise<TtsPlaybackResult> {
    const provider = this.providers.get(providerId)
    if (!provider) return { status: 'failed', reason: `unsupported_provider:${providerId}` }

    // 需要完整音频文件的 Sink（如 Live2D 口型）只能消费批合成结果。
    if (!this.preferBuffered() && provider.stream) {
      const streamed = await provider.stream(
        { text, voiceId },
        { signal: controller.signal, onSynthesisStart: hooks.onSynthesisStart },
      )
      if (streamed.status === 'skipped') return this.reportSkip(streamed)
      if (streamed.status === 'cancelled' || controller.signal.aborted) return { status: 'cancelled' }

      const sink = findAudioSink(this.sinks, streamed.source)
      if (sink) {
        await sink.play(streamed.source, { signal: controller.signal, onFirstAudio: hooks.onFirstAudio })
        return controller.signal.aborted ? { status: 'cancelled' } : { status: 'played' }
      }

      log.info('tts.stream_sink_missing', '没有 Sink 能播放该音频流，回退到批合成', {
        provider: providerId,
        format: streamed.source.format,
      })
      streamed.source.cancel()
    }

    return this.speakBuffered(providerId, text, voiceId, controller, hooks)
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
    if (synthesis.status === 'skipped') return this.reportSkip(synthesis)
    if (synthesis.status === 'cancelled' || controller.signal.aborted) return { status: 'cancelled' }
    this.configSkipKeys.clear()
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
}

// ============================================================
//  默认单例 — 向后兼容的模块级 API
// ============================================================

export const ttsEngine = new TtsEngine()

/** 语音播报是否开启 */
export function isTtsEnabled(): boolean { return ttsEngine.isEnabled() }
/** 设置语音播报开关 */
export function setTtsEnabled(enabled: boolean) { ttsEngine.setEnabled(enabled) }
/** 注册/注销 Live2D 口型播放器 */
export function setVoicePlayer(fn: VoicePlayer | null) { ttsEngine.setVoicePlayer(fn) }
