export type TtsPlaybackStatus = 'played' | 'skipped' | 'failed' | 'cancelled'

export interface TtsPlaybackResult {
  status: TtsPlaybackStatus
  reason?: string
}

export interface TtsPlaybackHooks {
  onSynthesisStart?: () => void
  onFirstAudio?: () => void
}

export type TtsPlaybackState =
  | 'preparing'
  | 'synthesizing'
  | 'playing'
  | TtsPlaybackStatus

export interface TtsPlaybackSnapshot {
  id: string
  requestId?: string
  state: TtsPlaybackState
  provider: 'none' | 'cosyvoice' | 'gptsovits'
  textLength: number
  voiceLanguage: string
  startedAt: number
  firstAudioAt: number | null
  finishedAt: number | null
  reason?: string
}

export interface TtsPlaybackRequest {
  requestId?: string
  text: string
  voiceId: string
  voiceLanguage: string
  /** 聊天回复默认去重；显式试听可选择不去重。 */
  deduplicate?: boolean
}

export interface TtsPlaybackEnginePort {
  isEnabled(): boolean
  provider(): TtsPlaybackSnapshot['provider']
  play(text: string, voiceId: string, hooks: TtsPlaybackHooks): Promise<TtsPlaybackResult>
  cancel(): void
}

type PlaybackListener = (snapshot: TtsPlaybackSnapshot | null) => void

const TERMINAL_STATES = new Set<TtsPlaybackState>(['played', 'skipped', 'failed', 'cancelled'])

/**
 * 应用层持有者：管理一次 TTS 播放会话。
 * provider 负责产出播放结果；调用方只负责请求、观察或取消会话。
 */
export class TtsPlaybackOrchestrator {
  private active: TtsPlaybackSnapshot | null = null
  private readonly listeners = new Set<PlaybackListener>()
  private sequence = 0
  private lastPlayedText = ''

  constructor(
    private readonly engine: TtsPlaybackEnginePort,
    private readonly now: () => number = Date.now,
  ) {}

  current(): TtsPlaybackSnapshot | null {
    return this.active ? { ...this.active } : null
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => this.listeners.delete(listener)
  }

  isPlaying(): boolean {
    return Boolean(this.active && !TERMINAL_STATES.has(this.active.state))
  }

  async play(request: TtsPlaybackRequest): Promise<TtsPlaybackResult> {
    const text = request.text.trim()
    const provider = this.engine.provider()
    // 每个被接受的播放请求都独占这条输出通道，
    // 即便预检随后判定该请求应当跳过。
    this.cancelActive('superseded')
    if (!text) return this.skip(request, provider, 'empty_text')
    if (request.deduplicate !== false && text === this.lastPlayedText) {
      return this.skip(request, provider, 'duplicate')
    }
    if (!this.engine.isEnabled()) return this.skip(request, provider, 'disabled')
    if (provider === 'none') return this.skip(request, provider, 'provider_none')

    const id = `tts-${this.now()}-${++this.sequence}`
    this.active = {
      id,
      requestId: request.requestId,
      state: 'preparing',
      provider,
      textLength: text.length,
      voiceLanguage: request.voiceLanguage,
      startedAt: this.now(),
      firstAudioAt: null,
      finishedAt: null,
    }
    this.publish()

    try {
      const result = await this.engine.play(text, request.voiceId, {
        onSynthesisStart: () => this.transitionCurrent(id, 'synthesizing'),
        onFirstAudio: () => this.transitionCurrent(id, 'playing', true),
      })
      if (this.active?.id !== id || this.active.state === 'cancelled') {
        return { status: 'cancelled', reason: this.active?.id === id ? this.active.reason : 'superseded' }
      }
      this.finish(id, result)
      if (result.status === 'played' && request.deduplicate !== false) this.lastPlayedText = text
      else if (result.status === 'cancelled') this.lastPlayedText = ''
      return result
    } catch (error) {
      if (this.active?.id !== id) return { status: 'cancelled', reason: 'superseded' }
      const result: TtsPlaybackResult = {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
      if (this.active.state !== 'cancelled') this.finish(id, result)
      return this.active.state === 'cancelled'
        ? { status: 'cancelled', reason: this.active.reason }
        : result
    }
  }

  /** 取消当前播放。resetDedupe 让被显式取消的语句可以重播。 */
  cancel(reason = 'cancelled', resetDedupe = false): boolean {
    if (resetDedupe) this.lastPlayedText = ''
    const cancelled = this.cancelActive(reason)
    // 迁移期间，适配器可能仍在为旧的试听调用方服务。
    if (!cancelled) this.engine.cancel()
    return cancelled
  }

  private cancelActive(reason: string): boolean {
    if (!this.active || TERMINAL_STATES.has(this.active.state)) return false
    this.engine.cancel()
    this.active = {
      ...this.active,
      state: 'cancelled',
      finishedAt: this.now(),
      reason,
    }
    this.publish()
    return true
  }

  private skip(
    request: TtsPlaybackRequest,
    provider: TtsPlaybackSnapshot['provider'],
    reason: string,
  ): TtsPlaybackResult {
    const timestamp = this.now()
    this.active = {
      id: `tts-${timestamp}-${++this.sequence}`,
      requestId: request.requestId,
      state: 'skipped',
      provider,
      textLength: request.text.trim().length,
      voiceLanguage: request.voiceLanguage,
      startedAt: timestamp,
      firstAudioAt: null,
      finishedAt: timestamp,
      reason,
    }
    this.publish()
    return { status: 'skipped', reason }
  }

  private transitionCurrent(id: string, state: 'synthesizing' | 'playing', firstAudio = false): void {
    if (this.active?.id !== id || TERMINAL_STATES.has(this.active.state)) return
    this.active = {
      ...this.active,
      state,
      firstAudioAt: firstAudio && this.active.firstAudioAt === null ? this.now() : this.active.firstAudioAt,
    }
    this.publish()
  }

  private finish(id: string, result: TtsPlaybackResult): void {
    if (this.active?.id !== id) return
    this.active = {
      ...this.active,
      state: result.status,
      finishedAt: this.now(),
      reason: result.reason,
    }
    this.publish()
  }

  private publish(): void {
    const snapshot = this.current()
    for (const listener of this.listeners) listener(snapshot)
  }
}
