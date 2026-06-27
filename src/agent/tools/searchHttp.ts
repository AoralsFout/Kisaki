/**
 * 搜索请求的网络层 —— 隔离「浏览器 fetch」与「Rust 转发」两种实现
 *
 * Phase 1：直接用 WebView fetch（Tavily 等 CORS 友好的 provider 可用）。
 * Phase 3：改为优先走 Tauri `web_search_fetch` 命令（reqwest 转发，避开 CORS、
 *          隐藏 Key），失败再回退 fetch。届时仅替换本文件，工具上层无感。
 */
import { createLogger } from '../../utils/logger'

const log = createLogger('SearchHttp')

export interface SearchHttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** JSON body（POST 时序列化发送） */
  body?: unknown
  /** 超时毫秒，默认 8000 */
  timeoutMs?: number
}

/**
 * 发送搜索请求并返回解析后的 JSON。
 * 失败（非 2xx / 网络错误 / 超时）抛出 Error，由工具 handler 兜底。
 */
export async function searchHttpJson<T = any>(req: SearchHttpRequest): Promise<T> {
  const { url, method = 'GET', headers = {}, body, timeoutMs = 8000 } = req

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    log.warn('搜索请求失败: HTTP %d - %s', res.status, text.slice(0, 200))
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  return (await res.json()) as T
}
