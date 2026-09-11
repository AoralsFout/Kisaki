export interface HttpRequest {
  url: string | URL
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  /** JSON 请求体；由传输层负责序列化。 */
  body?: unknown
}

export interface TransportResponse {
  status: number
  ok: boolean
  /** 可流式读取的响应体；缓冲型传输层（如后端代理）为 null。 */
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

/** 出站传输层：只描述「怎么把请求送出去」，不参与重试与超时策略。 */
export interface HttpTransport {
  readonly id: string
  send(request: HttpRequest, signal: AbortSignal): Promise<TransportResponse>
}
