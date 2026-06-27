/**
 * 联网搜索工具 - web_search
 *
 * 当问题涉及实时/最新/未知信息（新闻、事实、概念）时，LLM 调用本工具联网检索。
 * 支持可插拔 provider：Tavily（默认，专为 LLM 优化）/ Brave / SearXNG（自建）。
 * handler 返回纯文本（带来源 URL），LLM 在下一轮据此作答并标注来源。
 */
import type { Tool } from '../types'
import { createLogger } from '../../utils/logger'
import { loadSearchConfigSecure, isSearchConfigValid, type SearchConfig } from './searchConfig'
import { searchHttpJson } from './searchHttp'

const log = createLogger('ToolWebSearch')

/** 归一化后的单条搜索结果 */
interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 单条 snippet 最大字符，避免单结果占满 token 预算 */
const SNIPPET_MAX = 500
/** 整体返回最大字符 */
const RESULT_MAX = 4000

export const webSearchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索实时信息。当问题超出你的已有知识、需要最新数据（新闻、价格、版本、近期事件）或涉及不确定的事实时调用。返回若干条带来源链接的结果摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词，尽量具体明确',
          },
          count: {
            type: 'number',
            description: '返回结果条数（1-5），默认 3',
          },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year', 'any'],
            description: '时效范围，查最新信息用 day/week，默认 any',
          },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args) => {
    // 用 secure 版：主窗口重启后内存解密缓存为空，必须在此解密，否则会把
    // localStorage 里的「加密 Key」原样发出去 → 搜索服务返回 401。
    const config = await loadSearchConfigSecure()
    if (!isSearchConfigValid(config)) {
      return '联网搜索未启用或未配置，请在「设置 → API」中开启并填写搜索服务信息'
    }

    const query = String(args.query ?? '').trim()
    if (!query) return '请提供搜索关键词'
    const count = Math.min(Math.max(Number(args.count) || 3, 1), 5)
    const timeRange = normalizeTimeRange(args.time_range)

    log.debug('联网搜索: "%s" (provider=%s, count=%d, time=%s)', query, config.provider, count, timeRange)

    try {
      const hits = await search(config, query, count, timeRange)
      if (!hits.length) {
        log.info('搜索无结果: %s', query)
        return `未找到关于 "${query}" 的结果`
      }

      const text = hits
        .slice(0, count)
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}\n   来源: ${h.url}`)
        .join('\n\n')

      log.info('搜索成功: "%s" - %d 条结果', query, hits.length)
      return text.slice(0, RESULT_MAX)
    } catch (err) {
      const e = err as Error
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        log.warn('搜索超时: %s', query)
        return `搜索 "${query}" 超时，请稍后重试`
      }
      log.warn('搜索失败: %s - %s', query, e.message)
      return `搜索失败: ${e.message}`
    }
  },
}

/** 将任意输入归一化为有效 time_range（无效/any → undefined 表示不限） */
function normalizeTimeRange(input: unknown): 'day' | 'week' | 'month' | 'year' | undefined {
  const v = String(input ?? '').toLowerCase()
  if (v === 'day' || v === 'week' || v === 'month' || v === 'year') return v
  return undefined
}

/** 截断 snippet 并清理多余空白 */
function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)
}

/** 按 provider 分发搜索 */
async function search(
  config: SearchConfig,
  query: string,
  count: number,
  timeRange: 'day' | 'week' | 'month' | 'year' | undefined,
): Promise<SearchHit[]> {
  switch (config.provider) {
    case 'tavily':
      return searchTavily(config, query, count, timeRange)
    case 'brave':
      return searchBrave(config, query, count, timeRange)
    case 'searxng':
      return searchSearxng(config, query, timeRange)
    default:
      throw new Error(`未知搜索提供方: ${config.provider}`)
  }
}

// ─── Tavily ────────────────────────────────────────────
// 专为 LLM 优化，POST JSON，返回带正文摘要的结果。CORS 友好。
async function searchTavily(
  config: SearchConfig,
  query: string,
  count: number,
  timeRange: 'day' | 'week' | 'month' | 'year' | undefined,
): Promise<SearchHit[]> {
  const body: Record<string, unknown> = {
    query,
    max_results: count,
    search_depth: 'basic',
    topic: 'general',
  }
  if (timeRange) body.time_range = timeRange

  const data = await searchHttpJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>({
    url: 'https://api.tavily.com/search',
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body,
  })

  return (data.results ?? []).map((r) => ({
    title: r.title ?? '(无标题)',
    url: r.url ?? '',
    snippet: clip(r.content ?? ''),
  }))
}

// ─── Brave Search ──────────────────────────────────────
// GET + X-Subscription-Token。浏览器 CORS 受限，需 Phase 3 Rust 转发后才稳定可用。
async function searchBrave(
  config: SearchConfig,
  query: string,
  count: number,
  timeRange: 'day' | 'week' | 'month' | 'year' | undefined,
): Promise<SearchHit[]> {
  // Brave 用 freshness：pd(day)/pw(week)/pm(month)/py(year)
  const freshness = timeRange ? { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[timeRange] : ''
  const params = new URLSearchParams({ q: query, count: String(count) })
  if (freshness) params.set('freshness', freshness)

  const data = await searchHttpJson<{ web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>({
    url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    method: 'GET',
    headers: { 'X-Subscription-Token': config.apiKey },
  })

  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '(无标题)',
    url: r.url ?? '',
    snippet: clip(r.description ?? ''),
  }))
}

// ─── SearXNG（自建实例） ───────────────────────────────
// GET /search?format=json。无需 Key，CORS 取决于实例配置。
async function searchSearxng(
  config: SearchConfig,
  query: string,
  timeRange: 'day' | 'week' | 'month' | 'year' | undefined,
): Promise<SearchHit[]> {
  const base = config.baseURL.replace(/\/+$/, '')
  const params = new URLSearchParams({ q: query, format: 'json' })
  if (timeRange) params.set('time_range', timeRange)

  const data = await searchHttpJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>({
    url: `${base}/search?${params.toString()}`,
    method: 'GET',
  })

  return (data.results ?? []).map((r) => ({
    title: r.title ?? '(无标题)',
    url: r.url ?? '',
    snippet: clip(r.content ?? ''),
  }))
}
