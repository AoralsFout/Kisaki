/**
 * 搜索请求的网络层 —— 隔离「Rust 转发」与「浏览器 fetch」两种实现
 *
 * Tauri 环境：优先调用 `web_search_fetch` 命令（reqwest 转发，避开 CORS、隐藏 Key），
 *            解锁 Brave / SearXNG 等浏览器跨域受限的 provider。
 * 非 Tauri / 命令不可用：回退 WebView fetch（Tavily 等 CORS 友好的 provider 可用）。
 */
import { invoke } from '@tauri-apps/api/core'
import { createLogger } from '../../utils/logger'

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

/**
 * 发送搜索请求并返回解析后的 JSON。
 * 失败（非 2xx / 网络错误 / 超时）抛出 Error，由工具 handler 兜底。
 *
 * Tauri 环境：只走 Rust 转发并直接抛出其错误 —— 不回退 fetch，
 * 因为 WebView fetch 对多数 provider 必然撞 CORS，回退只会把真实的
 * 后端错误（DNS/TLS/代理/超时）掩盖成无意义的 "Failed to fetch"。
 */
export async function searchHttpJson<T = any>(req: SearchHttpRequest): Promise<T> {
  if (isTauri()) {
    return viaInvoke<T>(req)
  }
  return viaFetch<T>(req)
}

/** 经 Tauri Rust 命令转发 */
async function viaInvoke<T>(req: SearchHttpRequest): Promise<T> {
  let text: string
  try {
    text = await invoke<string>('web_search_fetch', {
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      body: req.body !== undefined ? JSON.stringify(req.body) : null,
    })
  } catch (err) {
    // 注意：invoke 失败时 reject 的是 Rust 端 Err(String)，是「字符串」而非 Error 对象，
    // 直接读 .message 会得到 undefined。这里统一归一化为可读文本再抛出。
    const msg = typeof err === 'string' ? err : ((err as Error)?.message ?? String(err))
    log.warn('Rust 转发失败: %s', msg)
    throw new Error(msg)
  }
  return JSON.parse(text) as T
}

/** 经 WebView fetch */
async function viaFetch<T>(req: SearchHttpRequest): Promise<T> {
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
