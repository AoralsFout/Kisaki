import type { ConversationImage, RecordedToolCall } from '../../domain/conversation/events'
import type { ProtocolToolCall } from './toolCallBatch'

export type ConversationRunState =
  | 'idle'
  | 'preparing'
  | 'streaming'
  | 'awaiting-approval'
  | 'executing-tools'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ConversationRunSnapshot {
  id: string
  state: ConversationRunState
  revision: number
  startedAt: number | null
  finishedAt: number | null
  reason: string | null
}

type ConversationRunListener = (snapshot: ConversationRunSnapshot) => void

const TERMINAL_STATES = new Set<ConversationRunState>(['completed', 'cancelled', 'failed'])

const ALLOWED_TRANSITIONS: Readonly<Record<ConversationRunState, readonly ConversationRunState[]>> = {
  idle: ['preparing', 'cancelled'],
  preparing: ['streaming', 'finalizing', 'cancelled', 'failed'],
  streaming: ['awaiting-approval', 'executing-tools', 'finalizing', 'cancelled', 'failed'],
  'awaiting-approval': ['executing-tools', 'cancelled', 'failed'],
  'executing-tools': ['streaming', 'awaiting-approval', 'finalizing', 'cancelled', 'failed'],
  finalizing: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
}

function clone(snapshot: ConversationRunSnapshot): ConversationRunSnapshot {
  return { ...snapshot }
}

export function isConversationRunActive(state: ConversationRunState): boolean {
  return state !== 'idle' && !TERMINAL_STATES.has(state)
}

export function isConversationRunUsingTools(state: ConversationRunState): boolean {
  return state === 'awaiting-approval' || state === 'executing-tools'
}

/**
 * 与框架无关的持有者：管理一次对话请求的生命周期。
 * 它的 AbortSignal 只是「已取消」状态的一个结果，而非另一份并行的真相来源。
 */
export class ConversationRun {
  private readonly controller = new AbortController()
  private readonly listeners = new Set<ConversationRunListener>()
  private value: ConversationRunSnapshot

  constructor(
    readonly id: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!id.trim()) throw new Error('Conversation run id must not be empty')
    this.value = {
      id,
      state: 'idle',
      revision: 0,
      startedAt: null,
      finishedAt: null,
      reason: null,
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  snapshot(): ConversationRunSnapshot {
    return clone(this.value)
  }

  subscribe(listener: ConversationRunListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  transition(next: ConversationRunState, reason: string | null = null): ConversationRunSnapshot {
    const current = this.value.state
    if (next === current) return this.snapshot()
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new Error(`Invalid conversation run transition: ${current} -> ${next}`)
    }

    const timestamp = this.now()
    this.value = {
      ...this.value,
      state: next,
      revision: this.value.revision + 1,
      startedAt: next === 'preparing' ? timestamp : this.value.startedAt,
      finishedAt: TERMINAL_STATES.has(next) ? timestamp : null,
      reason,
    }
    if (next === 'cancelled' && !this.controller.signal.aborted) this.controller.abort(reason ?? undefined)
    this.publish()
    return this.snapshot()
  }

  cancel(reason = 'cancelled'): ConversationRunSnapshot {
    // 回合结束不代表后台副作用就该放任不管：提交之后若有更新的请求顶替本次语音准备，
    // 中止信号依然必要。
    if (!this.controller.signal.aborted) this.controller.abort(reason)
    if (TERMINAL_STATES.has(this.value.state)) return this.snapshot()
    return this.transition('cancelled', reason)
  }

  private publish(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

type ConversationCoordinatorListener = (snapshot: ConversationRunSnapshot | null) => void

export interface ConversationToolTurnPorts {
  session: {
    recordToolCalls(step: {
      sessionId: string
      stepId: string
      calls: RecordedToolCall[]
      visibleText?: string
    }): Promise<boolean>
    recordToolResult(result: {
      sessionId: string
      callId: string
      content: string
      status: 'succeeded' | 'failed' | 'rejected'
      code?: string
    }): Promise<boolean>
  }
  modelContext: {
    addToolCalls(calls: readonly ProtocolToolCall[], visibleText?: string): void
    addToolResult(callId: string, content: string): void
    addToolImages(toolCallIds: string, images: readonly ConversationImage[]): void
  }
}

export interface CommitConversationToolCalls {
  sessionId: string
  stepId: string
  calls: readonly ProtocolToolCall[]
  visibleText?: string
}

export interface CommitConversationToolResult {
  sessionId: string
  callId: string
  content: string
  status: 'succeeded' | 'failed' | 'rejected'
  code?: string
}

export type ConversationTurnDirective = 'continue' | 'complete'

export type ConversationLoopResult =
  | { status: 'completed'; turnsUsed: number }
  | { status: 'cancelled'; turnsUsed: number }
  | { status: 'failed'; turnsUsed: number; error: unknown }
  | { status: 'turn-limit'; turnsUsed: number }

/**
 * 决定哪个 run 可以向共享 UI 投影。启动新 run 会顶替上一个，
 * 所有状态变更都以 run id 寻址，从而丢弃过期的工作。
 */
export class ConversationCoordinator {
  private active: ConversationRun | null = null
  private unsubscribeRun: (() => void) | null = null
  private readonly listeners = new Set<ConversationCoordinatorListener>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly toolTurns?: ConversationToolTurnPorts,
  ) {}

  current(): ConversationRunSnapshot | null {
    return this.active?.snapshot() ?? null
  }

  subscribe(listener: ConversationCoordinatorListener): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => this.listeners.delete(listener)
  }

  start(id: string): ConversationRun {
    this.active?.cancel('superseded')
    this.unsubscribeRun?.()

    const run = new ConversationRun(id, this.now)
    this.active = run
    this.unsubscribeRun = run.subscribe(() => this.publish())
    run.transition('preparing')
    return run
  }

  transition(id: string, next: ConversationRunState, reason: string | null = null): boolean {
    if (this.active?.id !== id || TERMINAL_STATES.has(this.active.snapshot().state)) return false
    this.active.transition(next, reason)
    return true
  }

  cancelActive(reason = 'cancelled'): boolean {
    if (!this.active || TERMINAL_STATES.has(this.active.snapshot().state)) return false
    this.active.cancel(reason)
    return true
  }

  isCurrent(id: string): boolean {
    return this.active?.id === id
  }

  mayProject(id: string): boolean {
    return this.active?.id === id && isConversationRunActive(this.active.snapshot().state)
  }

  /** 先把工具调用这一权威事实持久化，再暴露给实时模型上下文。 */
  async commitToolCalls(id: string, input: CommitConversationToolCalls): Promise<void> {
    const ports = this.requireToolTurnPorts()
    this.assertMayProject(id)
    const recorded = await ports.session.recordToolCalls({
      sessionId: input.sessionId,
      stepId: input.stepId,
      calls: input.calls.map(call => ({
        id: call.id,
        name: call.function.name,
        arguments: recordedArguments(call.function.arguments),
      })),
      visibleText: input.visibleText,
    })
    if (!recorded) throw new Error('工具调用未能写入当前会话')
    this.assertMayProject(id)
    ports.modelContext.addToolCalls(input.calls, input.visibleText)
  }

  /** 先持久化工具结果，再交给下一轮模型使用。 */
  async commitToolResult(id: string, input: CommitConversationToolResult): Promise<void> {
    const ports = this.requireToolTurnPorts()
    this.assertMayProject(id)
    const recorded = await ports.session.recordToolResult(input)
    if (!recorded) throw new Error('工具结果未能写入当前会话')
    this.assertMayProject(id)
    ports.modelContext.addToolResult(input.callId, input.content)
  }

  /** 图片只是临时的模型上下文；持久化的事实仍是工具结果本身。 */
  appendToolImages(
    id: string,
    toolCallIds: string,
    images: readonly ConversationImage[],
  ): void {
    this.assertMayProject(id)
    this.requireToolTurnPorts().modelContext.addToolImages(toolCallIds, images)
  }

  /**
   * 服务端的文本兜底在模型上下文里被塑造成一次合成的 say 交互。
   * 它有意不被持久化为真正的服务端工具调用。
   */
  appendSyntheticToolExchange(
    id: string,
    call: ProtocolToolCall,
    result: string,
  ): void {
    this.assertMayProject(id)
    const context = this.requireToolTurnPorts().modelContext
    context.addToolCalls([call])
    context.addToolResult(call.id, result)
  }

  /**
   * 负责有上限的模型轮次迭代，以及取消与错误的归类。
   * 轮次处理器只需说明领域流程是否还需要下一轮模型调用。
   */
  async runTurns(
    id: string,
    maxTurns: number,
    performTurn: (turn: number) => Promise<ConversationTurnDirective>,
  ): Promise<ConversationLoopResult> {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer')
    if (this.active?.id !== id) throw new Error(`Conversation run is not active: ${id}`)

    for (let turn = 0; turn < maxTurns; turn++) {
      const turnsUsed = turn + 1
      if (!this.mayProject(id) || this.active.signal.aborted) return { status: 'cancelled', turnsUsed: turn }
      this.transition(id, 'streaming')
      try {
        const directive = await performTurn(turn)
        if (!this.mayProject(id) || this.active.signal.aborted) return { status: 'cancelled', turnsUsed }
        if (directive === 'complete') return { status: 'completed', turnsUsed }
      } catch (error) {
        if (
          !this.mayProject(id)
          || this.active.signal.aborted
          || (error instanceof Error && error.name === 'AbortError')
        ) return { status: 'cancelled', turnsUsed }
        return { status: 'failed', turnsUsed, error }
      }
    }
    return { status: 'turn-limit', turnsUsed: maxTurns }
  }

  private publish(): void {
    const snapshot = this.current()
    for (const listener of this.listeners) listener(snapshot)
  }

  private requireToolTurnPorts(): ConversationToolTurnPorts {
    if (!this.toolTurns) throw new Error('Conversation tool turn ports are not configured')
    return this.toolTurns
  }

  private assertMayProject(id: string): void {
    if (this.mayProject(id)) return
    const error = new Error(`Conversation run cannot project tool context: ${id}`)
    error.name = 'AbortError'
    throw error
  }
}

function recordedArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* 保留下方格式异常的服务端输出 */ }
  return { _raw: raw, _invalid: true }
}
