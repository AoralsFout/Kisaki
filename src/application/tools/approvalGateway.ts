export type ApprovalDecision = 'allow' | 'allow-session' | 'reject'
export type ApprovalKind = 'file' | 'command' | 'screen-capture'

interface ApprovalRequestBase {
  id: string
  toolName: string
  args: Record<string, unknown>
  allowedDecisions: readonly ApprovalDecision[]
}

export interface FileApprovalRequest extends ApprovalRequestBase {
  kind: 'file'
  path: string
}

export interface CommandApprovalRequest extends ApprovalRequestBase {
  kind: 'command'
  summary: string
  details: unknown
}

export interface ScreenCaptureApprovalRequest extends ApprovalRequestBase {
  kind: 'screen-capture'
  target: 'cursor_monitor' | 'primary_monitor'
  includeKisaki: boolean
}

export type ApprovalRequest =
  | FileApprovalRequest
  | CommandApprovalRequest
  | ScreenCaptureApprovalRequest

type ApprovalListener = (request: ApprovalRequest | null) => void

interface PendingApproval {
  request: ApprovalRequest
  finish: (decision: ApprovalDecision) => void
}

/**
 * Owns the complete lifecycle of one user approval request. It is deliberately
 * framework-independent: UI state is a projection exposed through subscribe().
 */
export class ApprovalGateway {
  private pending: PendingApproval | null = null
  private readonly listeners = new Set<ApprovalListener>()

  constructor(
    private readonly timeoutMs = 5 * 60 * 1000,
    private readonly onTimeout: (request: ApprovalRequest) => void = () => {},
  ) {}

  current(): ApprovalRequest | null {
    return this.pending?.request ?? null
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => this.listeners.delete(listener)
  }

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    this.rejectPending()
    if (signal.aborted) return Promise.resolve('reject')

    return new Promise(resolve => {
      let settled = false
      const finish = (decision: ApprovalDecision) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        signal.removeEventListener('abort', onAbort)
        if (this.pending?.finish === finish) {
          this.pending = null
          this.publish()
        }
        resolve(decision)
      }
      const onAbort = () => finish('reject')
      const timeoutId = setTimeout(() => {
        this.onTimeout(request)
        finish('reject')
      }, this.timeoutMs)

      this.pending = { request, finish }
      signal.addEventListener('abort', onAbort, { once: true })
      this.publish()
    })
  }

  resolve(decision: ApprovalDecision): boolean {
    const pending = this.pending
    if (!pending || !pending.request.allowedDecisions.includes(decision)) return false
    pending.finish(decision)
    return true
  }

  rejectPending(): void {
    this.pending?.finish('reject')
  }

  private publish(): void {
    const request = this.current()
    for (const listener of this.listeners) listener(request)
  }
}
