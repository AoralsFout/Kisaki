/**
 * 搜索请求的网络层 —— 只负责选择传输层与描述搜索策略
 *
 * Tauri 环境：走 `web_search_fetch` 命令（reqwest 转发，避开 CORS、隐藏 Key），
 *            解锁 Brave / SearXNG 等浏览器跨域受限的 provider，超时由 Rust 侧负责。
 * 非 Tauri：走 WebView fetch（Tavily 等 CORS 友好的 provider 可用）。
 *
 * 超时、取消与失败分类统一由 RequestExecutor 提供。
 */
import { createLogger } from '../../utils/logger'
import { RequestError } from '../../application/net/requestError'
import { RequestExecutor, type RequestTelemetrySink } from '../../application/net/requestExecutor'
import { fetchTransport } from '../../infrastructure/net/fetchTransport'
import { tauriProxyTransport } from '../../infrastructure/net/tauriProxyTransport'

const log = createLogger('SearchHttp')

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: Record<string, unknown>
  __TAURI__?: Record<string, unknown>
}

/** 是否运行在 Tauri 环境（与 utils/logger 的检测保持一致） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    (window as TauriWindow).__TAURI_INTERNALS__ !== undefined ||
    (window as TauriWindow).__TAURI__ !== undefined
  )
}

export interface SearchHttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** JSON body（POST 时序列化发送） */
  body?: unknown
  /** 超时毫秒，默认 8000（仅 fetch 回退路径生效；Rust 侧固定 10s） */
  timeoutMs?: number
}

const telemetry: RequestTelemetrySink = {
  attemptFailed: event => log.warn(
    'search_http.attempt_failed',
    `搜索请求失败（第 ${event.attempt} 次）`,
    event.error,
    { kind: event.error.kind, status: event.error.status, attempt: event.attempt },
  ),
  completed: () => {},
}

const executor = new RequestExecutor(telemetry)

/** 搜索请求策略：单次尝试，失败即交给工具 handler 兜底。 */
const SEARCH_POLICY = { label: 'search.http', maxAttempts: 1 } as const

/**
 * 发送搜索请求并返回解析后的 JSON。
 * 失败（非 2xx / 网络错误 / 超时）抛出 Error，由工具 handler 兜底。
 *
 * Tauri 环境：只走 Rust 转发并直接抛出其错误 —— 不回退 fetch，
 * 因为 WebView fetch 对多数 provider 必然撞 CORS，回退只会把真实的
 * 后端错误（DNS/TLS/代理/超时）掩盖成无意义的 "Failed to fetch"。
 */
export async function searchHttpJson<T = any>(req: SearchHttpRequest): Promise<T> {
  const useProxy = isTauri()
  return executor.run<T>({
    request: {
      url: req.url,
      method: req.method ?? 'GET',
      headers: { Accept: 'application/json', ...req.headers },
      body: req.body,
    },
    transport: useProxy ? tauriProxyTransport : fetchTransport,
    policy: useProxy
      // Rust 侧已有 10s 客户端超时，前端不再叠加
      ? { ...SEARCH_POLICY, timeoutMs: null }
      : { ...SEARCH_POLICY, timeoutMs: req.timeoutMs ?? 8000 },
    consume: async response => {
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        log.warn("search_http.request_failed.warn", `搜索请求失败: HTTP ${response.status}`, undefined, { res_status: response.status, response_length: text.length })
        log.sensitiveDebug("search_http.response_sensitive.debug", "搜索失败响应片段", { status: response.status, text_slice: text.slice(0, 200) })
        throw new RequestError('http', `HTTP ${response.status}: ${text.slice(0, 200)}`, {
          status: response.status,
          retryable: false,
        })
      }
      return await response.json<T>()
    },
  })
}
