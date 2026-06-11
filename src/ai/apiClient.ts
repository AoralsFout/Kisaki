/**
 * 通用 API 客户端
 *
 * 特性：
 * - 指数退避重试（可配置最大重试次数）
 * - 请求取消（AbortSignal）
 * - 格式化错误信息
 * - 延迟初始化（支持非浏览器环境）
 */

import { createLogger } from '../utils/logger'

const log = createLogger('ApiClient')

// ─── 类型 ─────────────────────────────────────────────

export interface ApiClientConfig {
  /** 基础 URL */
  baseURL: string
  /** 认证 Bearer Token */
  apiKey: string
  /** 超时时间（毫秒，默认 30000） */
  timeoutMs: number
  /** 最大重试次数（默认 2） */
  maxRetries: number
  /** 重试初始延迟（毫秒，默认 1000） */
  retryDelayMs: number
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  /** 取消信号 */
  signal?: AbortSignal
  /** 覆盖当前实例的超时 */
  timeoutMs?: number
}

export interface ApiResponse<T = unknown> {
  ok: boolean
  status: number
  data: T
  /** 错误信息（仅 ok=false 时） */
  error?: string
}

// ─── 客户端实现 ───────────────────────────────────────

export class ApiClient {
  private config: ApiClientConfig

  constructor(config: Partial<ApiClientConfig> = {}) {
    this.config = {
      baseURL: '',
      apiKey: '',
      timeoutMs: 30000,
      maxRetries: 2,
      retryDelayMs: 1000,
      ...config,
    }
  }

  /** 更新配置 */
  setConfig(partial: Partial<ApiClientConfig>) {
    this.config = { ...this.config, ...partial }
  }

  /** 获取完整 URL */
  private resolveUrl(path: string): string {
    const base = this.config.baseURL.replace(/\/+$/, '')
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return `${base}${cleanPath}`
  }

  /** 构建默认请求头 */
  private defaultHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }
    return headers
  }

  /**
   * 发送请求（含重试逻辑）
   */
  async request<T = unknown>(
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = this.resolveUrl(path)
    const headers = { ...this.defaultHeaders(), ...options.headers }
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined

    let lastError: string = ''
    const maxRetries = this.config.maxRetries

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 为每次重试创建独立的 AbortController（叠加外部 signal）
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

        // 合并外部 signal
        if (options.signal) {
          options.signal.addEventListener('abort', () => abortController.abort(), { once: true })
        }

        const response = await fetch(url, {
          method: options.method ?? 'POST',
          headers,
          body,
          signal: abortController.signal,
        })

        clearTimeout(timeoutId)

        // 尝试解析响应体
        const responseText = await response.text()
        let data: T
        try {
          data = JSON.parse(responseText) as T
        } catch {
          data = responseText as unknown as T
        }

        if (!response.ok) {
          const errMsg = typeof data === 'string'
            ? data.slice(0, 200)
            : JSON.stringify(data).slice(0, 200)

          // 5xx 错误才重试（服务端问题），4xx 不重试
          if (response.status >= 500 && attempt < maxRetries) {
            lastError = `HTTP ${response.status}: ${errMsg}`
            await this.delay(attempt)
            continue
          }

          return {
            ok: false,
            status: response.status,
            data,
            error: `HTTP ${response.status}: ${errMsg}`,
          }
        }

        return { ok: true, status: response.status, data }
      } catch (err) {
        const isAbort = (err as Error).name === 'AbortError'
        if (isAbort) {
          return { ok: false, status: 0, data: null as T, error: '请求已取消或超时' }
        }

        lastError = (err as Error).message

        // 网络错误才重试
        if (attempt < maxRetries) {
          log.warn('请求失败，第 %d 次重试: %s', attempt + 1, lastError)
          await this.delay(attempt)
          continue
        }
      }
    }

    return { ok: false, status: 0, data: null as T, error: lastError }
  }

  /** 指数退避延迟 */
  private async delay(attempt: number): Promise<void> {
    const ms = Math.min(
      this.config.retryDelayMs * Math.pow(2, attempt),
      10000, // 最大 10 秒
    )
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}

/** 默认全局 API 客户端实例 */
export const defaultApiClient = new ApiClient()
