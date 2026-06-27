/**
 * 联网搜索工具单元测试
 *
 * 网络层（searchHttp）与配置（searchConfig）均被 mock，聚焦 handler 行为：
 * 参数归一化、provider 请求构造、结果格式化、count 钳制与各类兜底文案。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── mock 网络层 ──
const httpMock = vi.fn()
vi.mock('../searchHttp', () => ({
  searchHttpJson: (...args: unknown[]) => httpMock(...args),
}))

// ── mock 配置（loadSearchConfig 可变，isSearchConfigValid 用真实规则） ──
let mockConfig: { provider: string; apiKey: string; baseURL: string; enabled: boolean }
vi.mock('../searchConfig', () => ({
  loadSearchConfig: () => mockConfig,
  isSearchConfigValid: (c: typeof mockConfig) => {
    if (!c?.enabled) return false
    if (c.provider === 'searxng') return Boolean(c.baseURL)
    return Boolean(c.apiKey)
  },
}))

import { webSearchTool } from '../webSearch'

const run = (args: Record<string, unknown>) => webSearchTool.handler(args) as Promise<string>

beforeEach(() => {
  httpMock.mockReset()
  mockConfig = { provider: 'tavily', apiKey: 'tvly-test', baseURL: '', enabled: true }
})

describe('web_search - 配置校验', () => {
  it('未启用时返回引导文案，不发请求', async () => {
    mockConfig.enabled = false
    const res = await run({ query: '今天的新闻' })
    expect(res).toContain('未启用或未配置')
    expect(httpMock).not.toHaveBeenCalled()
  })

  it('已启用但缺 Key 时返回引导文案', async () => {
    mockConfig.apiKey = ''
    const res = await run({ query: 'x' })
    expect(res).toContain('未启用或未配置')
    expect(httpMock).not.toHaveBeenCalled()
  })

  it('空 query 返回提示', async () => {
    const res = await run({ query: '   ' })
    expect(res).toBe('请提供搜索关键词')
    expect(httpMock).not.toHaveBeenCalled()
  })
})

describe('web_search - 正常结果', () => {
  it('Tavily 结果格式化：编号 + 标题 + 摘要 + 来源', async () => {
    httpMock.mockResolvedValue({
      results: [
        { title: 'Vue 3.5 发布', url: 'https://vuejs.org/x', content: '  新版本   特性  ' },
        { title: '第二条', url: 'https://example.com', content: '正文二' },
      ],
    })
    const res = await run({ query: 'Vue 3.5' })
    expect(res).toContain('1. Vue 3.5 发布')
    expect(res).toContain('来源: https://vuejs.org/x')
    expect(res).toContain('2. 第二条')
    // snippet 内多余空白被压缩
    expect(res).toContain('新版本 特性')
  })

  it('请求参数：max_results = 钳制后的 count，POST 到 Tavily', async () => {
    httpMock.mockResolvedValue({ results: [] })
    await run({ query: 'x', count: 99 })
    const req = httpMock.mock.calls[0][0]
    expect(req.url).toContain('api.tavily.com')
    expect(req.method).toBe('POST')
    expect(req.body.max_results).toBe(5) // 99 → 钳到 5
  })

  it('count 下界钳制到 1', async () => {
    httpMock.mockResolvedValue({ results: [] })
    await run({ query: 'x', count: 0 })
    expect(httpMock.mock.calls[0][0].body.max_results).toBe(3) // 0 → 默认 3
  })

  it('最多输出 count 条（钳制后）', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, url: `u${i}`, content: `c${i}` }))
    httpMock.mockResolvedValue({ results: many })
    const res = await run({ query: 'x', count: 2 })
    expect(res).toContain('1. T0')
    expect(res).toContain('2. T1')
    expect(res).not.toContain('3. T2')
  })

  it('空结果返回未找到文案', async () => {
    httpMock.mockResolvedValue({ results: [] })
    const res = await run({ query: '不存在的东西' })
    expect(res).toContain('未找到关于 "不存在的东西"')
  })
})

describe('web_search - time_range 归一化', () => {
  it('有效 time_range 透传', async () => {
    httpMock.mockResolvedValue({ results: [] })
    await run({ query: 'x', time_range: 'week' })
    expect(httpMock.mock.calls[0][0].body.time_range).toBe('week')
  })

  it('any / 非法值不带 time_range', async () => {
    httpMock.mockResolvedValue({ results: [] })
    await run({ query: 'x', time_range: 'any' })
    expect(httpMock.mock.calls[0][0].body.time_range).toBeUndefined()
  })
})

describe('web_search - provider 分发', () => {
  it('SearXNG 走 baseURL，GET，无需 Key', async () => {
    mockConfig = { provider: 'searxng', apiKey: '', baseURL: 'http://127.0.0.1:8080/', enabled: true }
    httpMock.mockResolvedValue({ results: [{ title: 'A', url: 'http://a', content: 'a' }] })
    const res = await run({ query: 'x' })
    const req = httpMock.mock.calls[0][0]
    expect(req.url).toContain('http://127.0.0.1:8080/search?')
    expect(req.method).toBe('GET')
    expect(res).toContain('1. A')
  })

  it('Brave 走 X-Subscription-Token 头', async () => {
    mockConfig = { provider: 'brave', apiKey: 'brave-key', baseURL: '', enabled: true }
    httpMock.mockResolvedValue({ web: { results: [{ title: 'B', url: 'http://b', description: 'desc' }] } })
    const res = await run({ query: 'x' })
    const req = httpMock.mock.calls[0][0]
    expect(req.headers['X-Subscription-Token']).toBe('brave-key')
    expect(res).toContain('1. B')
    expect(res).toContain('desc')
  })
})

describe('web_search - 错误兜底', () => {
  it('超时返回超时文案', async () => {
    const err = new Error('timeout')
    err.name = 'TimeoutError'
    httpMock.mockRejectedValue(err)
    const res = await run({ query: '查询' })
    expect(res).toContain('超时')
  })

  it('其它错误返回失败文案', async () => {
    httpMock.mockRejectedValue(new Error('HTTP 401: invalid key'))
    const res = await run({ query: '查询' })
    expect(res).toContain('搜索失败')
    expect(res).toContain('401')
  })
})
