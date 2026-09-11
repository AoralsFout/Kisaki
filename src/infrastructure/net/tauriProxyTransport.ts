import { invoke } from '@tauri-apps/api/core'
import { RequestError } from '../../application/net/requestError'
import type { HttpRequest, HttpTransport, TransportResponse } from '../../application/net/transport'

/**
 * 经 Rust 转发的传输层：避开 CORS 并隐藏凭据。
 * invoke 不支持 AbortSignal，超时由 Rust 侧客户端负责，因此返回缓冲响应体。
 */
export const tauriProxyTransport: HttpTransport = {
  id: 'tauri-proxy',

  async send(request: HttpRequest, _signal: AbortSignal): Promise<TransportResponse> {
    let text: string
    try {
      text = await invoke<string>('web_search_fetch', {
        url: String(request.url),
        method: request.method ?? 'GET',
        headers: request.headers ?? {},
        body: request.body === undefined ? null : JSON.stringify(request.body),
      })
    } catch (cause) {
      // invoke 失败时 reject 的是 Rust 端 Err(String)，是字符串而非 Error 对象。
      const message = typeof cause === 'string'
        ? cause
        : ((cause as Error)?.message ?? String(cause))
      throw new RequestError('network', message, { retryable: false, cause })
    }
    return {
      status: 200,
      ok: true,
      body: null,
      text: async () => text,
      json: async <T,>() => JSON.parse(text) as T,
    }
  },
}
