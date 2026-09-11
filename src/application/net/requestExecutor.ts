import { RequestError, toRequestError } from './requestError'
import type { HttpRequest, HttpTransport, TransportResponse } from './transport'

export interface RequestPolicy {
  /** 遥测与日志用的请求标识，例如 'ai.chat'。 */
  label: string
  /** 单次尝试的总时限（含读取响应体）；null 表示由传输层或后端自行限时。 */
  timeoutMs: number | null
  maxAttempts?: number
  backoffBaseMs?: number
  isRetryableStatus?(status: number): boolean
}

export interface RequestAttemptFailed {
  label: string
  attempt: number
  error: RequestError
}

/** 请求遥测端口；事件名由调用方绑定到自己的日志作用域。 */
export interface RequestTelemetrySink {
  attemptFailed(event: RequestAttemptFailed): void
  completed(event: { label: string; attempt: number }): void
}

export interface RequestExecution<T> {
  request: HttpRequest
  transport: HttpTransport
  policy: RequestPolicy
  /** 调用方取消信号；一旦触发立即停止且不再重试。 */
  signal?: AbortSignal
  consume(response: TransportResponse, signal: AbortSignal): Promise<T>
}

const DEFAULT_MAX_ATTEMPTS = 1
const DEFAULT_BACKOFF_BASE_MS = 600
const MAX_BACKOFF_MS = 10_000

/** 429 / 5xx 属于可重试的瞬时状态。 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** 合并两个 AbortSignal：任一触发则合并信号触发。 */
export function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (primary.aborted || secondary.aborted) {
    controller.abort()
    return controller.signal
  }
  const onAbort = () => controller.abort()
  primary.addEventListener('abort', onAbort, { once: true })
  secondary.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

function delayMs(base: number, attempt: number): number {
  return Math.min(base * attempt, MAX_BACKOFF_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 统一的请求执行策略：超时、重试、取消与失败分类。
 *
 * 每次尝试都持有独立的超时信号；重试只发生在「尚未开始消费响应」的阶段，
 * 或消费者主动抛出可重试错误时。消费阶段的错误由消费者决定是否可重试。
 */
export class RequestExecutor {
  constructor(private readonly telemetry?: RequestTelemetrySink) {}

  async run<T>(execution: RequestExecution<T>): Promise<T> {
    const { request, transport, policy, signal: callerSignal, consume } = execution
    const maxAttempts = Math.max(1, policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    const backoffBase = policy.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    const retryableStatus = policy.isRetryableStatus ?? isRetryableStatus

    for (let attempt = 1; ; attempt++) {
      const timeout = new AbortController()
      const timer = policy.timeoutMs === null
        ? null
        : setTimeout(() => timeout.abort(), policy.timeoutMs)
      const signal = callerSignal ? combineAbortSignals(callerSignal, timeout.signal) : timeout.signal

      try {
        const response = await transport.send(request, signal)
        if (!response.ok && retryableStatus(response.status) && attempt < maxAttempts) {
          this.telemetry?.attemptFailed({
            label: policy.label,
            attempt,
            error: new RequestError('http', `HTTP ${response.status}`, {
              status: response.status,
              retryable: true,
            }),
          })
          await sleep(delayMs(backoffBase, attempt))
          continue
        }

        const result = await consume(response, signal)
        this.telemetry?.completed({ label: policy.label, attempt })
        return result
      } catch (cause) {
        const error = toRequestError(cause, { callerAborted: callerSignal?.aborted === true })
        if (error.kind === 'cancelled' || !error.retryable || attempt >= maxAttempts) throw error
        this.telemetry?.attemptFailed({ label: policy.label, attempt, error })
        await sleep(delayMs(backoffBase, attempt))
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }
  }
}
