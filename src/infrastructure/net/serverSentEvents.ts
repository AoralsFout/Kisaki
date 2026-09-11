/**
 * 读取 SSE 响应体，逐个产出 data 负载（不含 `data: ` 前缀）。
 * 只负责行协议与跨分片的帧重组；`[DONE]`、JSON 解析和领域分发由调用方决定。
 */
export async function* readServerSentEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const payload = parseEventLine(line)
      if (payload !== null) yield payload
    }
  }

  // 流结束时可能出现没有换行符的最后一行
  const tail = parseEventLine(buffer)
  if (tail !== null) yield tail
}

/** 从单行 SSE 文本中取出 data 负载；非 data 行返回 null。 */
export function parseEventLine(line: string): string | null {
  const trimmed = line.trim()
  return trimmed.startsWith('data: ') ? trimmed.slice(6) : null
}
