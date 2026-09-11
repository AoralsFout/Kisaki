import { describe, expect, it, vi } from 'vitest'
import { RequestError } from './requestError'
import { RequestExecutor, type RequestTelemetrySink } from './requestExecutor'
import type { HttpTransport, TransportResponse } from './transport'

function response(status: number, body = ''): TransportResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: null,
    text: async () => body,
    json: async <T,>() => JSON.parse(body) as T,
  }
}

function transportOf(...responses: (TransportResponse | Error)[]): HttpTransport {
  const send = vi.fn()
  for (const item of responses) {
    if (item instanceof Error) send.mockRejectedValueOnce(item)
    else send.mockResolvedValueOnce(item)
  }
  return { id: 'test', send }
}

const policy = { label: 'test', timeoutMs: null } as const

describe('RequestExecutor', () => {
  it('retries retryable statuses without consuming the failed response', async () => {
    const transport = transportOf(response(503, 'busy'), response(200, '{"ok":true}'))
    const consume = vi.fn(async (value: TransportResponse) => value.json())
    const telemetry: RequestTelemetrySink = { attemptFailed: vi.fn(), completed: vi.fn() }

    const result = await new RequestExecutor(telemetry).run({
      request: { url: 'https://example.test' },
      transport,
      policy: { ...policy, maxAttempts: 3, backoffBaseMs: 0 },
      consume,
    })

    expect(result).toEqual({ ok: true })
    expect(transport.send).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenCalledOnce()
    expect(telemetry.attemptFailed).toHaveBeenCalledOnce()
    expect(telemetry.completed).toHaveBeenCalledWith({ label: 'test', attempt: 2 })
  })

  it('does not retry client errors', async () => {
    const transport = transportOf(response(401, 'nope'))
    const executor = new RequestExecutor()

    await expect(executor.run({
      request: { url: 'https://example.test' },
      transport,
      policy: { ...policy, maxAttempts: 3, backoffBaseMs: 0 },
      consume: async value => {
        throw new RequestError('http', `HTTP ${value.status}`, { status: value.status, retryable: false })
      },
    })).rejects.toMatchObject({ kind: 'http', status: 401 })

    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('stops immediately when the caller cancels', async () => {
    const controller = new AbortController()
    const send = vi.fn(async () => {
      controller.abort()
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    const transport: HttpTransport = {
      id: 'test',
      send,
    }

    await expect(new RequestExecutor().run({
      request: { url: 'https://example.test' },
      transport,
      policy: { ...policy, maxAttempts: 5, backoffBaseMs: 0 },
      signal: controller.signal,
      consume: async () => 'never',
    })).rejects.toMatchObject({ kind: 'cancelled', retryable: false })

    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('classifies a timeout and retries it', async () => {
    const transport = transportOf(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      response(200, 'ok'),
    )

    const result = await new RequestExecutor().run({
      request: { url: 'https://example.test' },
      transport,
      policy: { label: 'timeout-test', timeoutMs: 50, maxAttempts: 2, backoffBaseMs: 0 },
      consume: async value => value.text(),
    })

    expect(result).toBe('ok')
    expect(transport.send).toHaveBeenCalledTimes(2)
  })

  it('gives the consumer a signal that is aborted on timeout', async () => {
    const transport = transportOf(response(200, 'stream'))
    let observed: AbortSignal | null = null

    await new RequestExecutor().run({
      request: { url: 'https://example.test' },
      transport,
      policy: { label: 'signal-test', timeoutMs: 30 },
      consume: async (_value, signal) => {
        observed = signal
        return 'done'
      },
    })

    expect(observed).not.toBeNull()
    expect((observed as unknown as AbortSignal).aborted).toBe(false)
  })

  it('retries consumer errors only when the consumer marks them retryable', async () => {
    const transport = transportOf(response(200, 'partial'), response(200, 'complete'))
    let attempt = 0

    const result = await new RequestExecutor().run({
      request: { url: 'https://example.test' },
      transport,
      policy: { label: 'stream-reset', timeoutMs: null, maxAttempts: 3, backoffBaseMs: 0 },
      consume: async value => {
        attempt += 1
        if (attempt === 1) {
          throw new RequestError('network', 'stream reset', { retryable: true })
        }
        return value.text()
      },
    })

    expect(result).toBe('complete')
    expect(transport.send).toHaveBeenCalledTimes(2)
  })

  it('never retries consumer errors marked unrecoverable', async () => {
    const transport = transportOf(response(200, 'partial'))

    await expect(new RequestExecutor().run({
      request: { url: 'https://example.test' },
      transport,
      policy: { label: 'stream-mid-flight', timeoutMs: null, maxAttempts: 3, backoffBaseMs: 0 },
      consume: async () => {
        throw new RequestError('network', 'stream broke after content', { retryable: false })
      },
    })).rejects.toMatchObject({ kind: 'network', retryable: false })

    expect(transport.send).toHaveBeenCalledOnce()
  })
})
