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
 * Framework-independent owner of one conversation request lifecycle.
 * Its AbortSignal is an effect of the cancelled state, not a parallel source of truth.
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
    // Completion does not make background effects immortal. Aborting the signal is
    // still useful when a newer request supersedes voice preparation after commit.
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

/**
 * Owns which run may project into the shared UI. Starting a run supersedes the
 * previous one, and all state changes are addressed by run id to reject stale work.
 */
export class ConversationCoordinator {
  private active: ConversationRun | null = null
  private unsubscribeRun: (() => void) | null = null
  private readonly listeners = new Set<ConversationCoordinatorListener>()

  constructor(private readonly now: () => number = Date.now) {}

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

  private publish(): void {
    const snapshot = this.current()
    for (const listener of this.listeners) listener(snapshot)
  }
}
