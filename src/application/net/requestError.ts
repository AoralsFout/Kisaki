export type RequestFailureKind =
  /** 单次尝试超过时限。 */
  | 'timeout'
  /** 调用方主动取消。 */
  | 'cancelled'
  /** 传输层失败（DNS、TLS、代理、后端命令错误等）。 */
  | 'network'
  /** 服务端返回非 2xx。 */
  | 'http'
  /** 响应体无法解析。 */
  | 'response'

export interface RequestErrorOptions {
  status?: number
  retryable?: boolean
  cause?: unknown
}

/** 所有出站请求的统一失败分类。 */
export class RequestError extends Error {
  readonly kind: RequestFailureKind
  readonly status: number | null
  readonly retryable: boolean
  /** 原始错误（lib 目标为 ES2020，因此显式声明）。 */
  readonly cause?: unknown

  constructor(kind: RequestFailureKind, message: string, options: RequestErrorOptions = {}) {
    super(message)
    this.name = 'RequestError'
    this.kind = kind
    this.status = options.status ?? null
    this.retryable = options.retryable ?? (kind === 'timeout' || kind === 'network')
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** 把 fetch / invoke / 自定义错误归一化为 RequestError。 */
export function toRequestError(
  cause: unknown,
  options: { callerAborted?: boolean } = {},
): RequestError {
  if (cause instanceof RequestError) return cause

  const name = (cause as Error | undefined)?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return options.callerAborted
      ? new RequestError('cancelled', '请求已取消', { cause, retryable: false })
      : new RequestError('timeout', '请求超时', { cause })
  }

  const message = (cause as Error | undefined)?.message || String(cause)
  return new RequestError('network', message, { cause })
}
