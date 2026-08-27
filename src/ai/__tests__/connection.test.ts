import { afterEach, describe, expect, it, vi } from 'vitest'
import { testAIConnection } from '../client'

afterEach(() => vi.unstubAllGlobals())

describe('testAIConnection', () => {
  const config = { baseURL: 'https://example.com/v1', apiKey: 'secret', model: 'model' }

  it('uses the models endpoint without exposing the key in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(testAIConnection(config)).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://example.com/v1/models'),
      expect.objectContaining({ method: 'GET' }),
    )
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret')
  })

  it('returns a clear credential error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await expect(testAIConnection(config)).resolves.toEqual({
      ok: false,
      error: 'API Key 无效或无权访问',
    })
  })

  it('rejects invalid URLs before fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await testAIConnection({ ...config, baseURL: 'not a url' })
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
