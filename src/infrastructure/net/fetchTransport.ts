import type { HttpRequest, HttpTransport, TransportResponse } from '../../application/net/transport'

/** WebView fetch 传输层；支持流式读取响应体。 */
export const fetchTransport: HttpTransport = {
  id: 'fetch',

  async send(request: HttpRequest, signal: AbortSignal): Promise<TransportResponse> {
    const hasBody = request.body !== undefined
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: hasBody
        ? { 'Content-Type': 'application/json', ...request.headers }
        : request.headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
      signal,
    })
    return {
      status: response.status,
      ok: response.ok,
      body: response.body,
      text: () => response.text(),
      json: async <T,>() => await response.json() as T,
    }
  },
}
