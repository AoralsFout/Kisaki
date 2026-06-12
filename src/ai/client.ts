/**
 * AI API 客户端
 *
 * 使用 OpenAI 兼容格式，支持大多数 LLM Provider。
 * 支持流式输出 + Function Calling (Tool Use)。
 */
import type { AIConfig, ChatMessage, StreamCallbacks, ToolCallData, ResponseFormat } from './types'
import { BILINGUAL_OUTPUT_SCHEMA } from './types'
import { createLogger } from '../utils/logger'

const log = createLogger('API')

/** 默认配置 */
export const DEFAULT_CONFIG: AIConfig = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
}

/** 工具定义格式 */
interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

import { STORAGE_AI_CONFIG } from '../constants'
import { encrypt, decrypt } from '../utils/crypto'

/** 保存的配置键名 */
const STORAGE_KEY = STORAGE_AI_CONFIG

/** 解密后的 API Key 缓存 */
let _decryptedApiKeyCache: string | null = null

export function setDecryptedApiKeyCache(key: string) {
  _decryptedApiKeyCache = key
}

export function loadConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AIConfig
      if (_decryptedApiKeyCache) parsed.apiKey = _decryptedApiKeyCache
      return parsed
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG }
}

export function saveConfig(config: AIConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

/**
 * 保存配置并加密 API Key
 */
export async function saveConfigSecure(config: AIConfig) {
  if (config.apiKey) {
    setDecryptedApiKeyCache(config.apiKey)
    const encrypted = await encrypt(config.apiKey)
    saveConfig({ ...config, apiKey: encrypted })
  } else {
    saveConfig(config)
  }
}

/**
 * 加载配置并解密 API Key，自动迁移旧明文
 */
export async function loadConfigSecure(): Promise<AIConfig> {
  const config = loadConfig()
  if (_decryptedApiKeyCache) return { ...config, apiKey: _decryptedApiKeyCache }

  if (config.apiKey && config.apiKey.length > 20 && !config.apiKey.startsWith('sk-')) {
    const decrypted = await decrypt(config.apiKey)
    if (decrypted !== config.apiKey) {
      setDecryptedApiKeyCache(decrypted)
      // 仅缓存解密结果，不把明文写回 localStorage（保持磁盘上加密 + 避免跨窗口 storage 事件回环）
      return { ...config, apiKey: decrypted }
    }
  }
  if (config.apiKey && config.apiKey.startsWith('sk-')) {
    setDecryptedApiKeyCache(config.apiKey)
    const encrypted = await encrypt(config.apiKey)
    saveConfig({ ...config, apiKey: encrypted })
  }
  return config
}

// 跨窗口配置同步：设置窗口保存配置后，其它窗口（主窗口）会收到 storage 事件。
// 此时失效本窗口的解密缓存并立即重新解密，避免继续使用旧的 API Key。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    _decryptedApiKeyCache = null
    loadConfigSecure().catch(() => { /* 静默：下次 loadConfigSecure 会重试 */ })
  })
}

export function isConfigValid(config: AIConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model)
}

/**
 * 检测当前模型是否支持结构化输出（JSON Schema 严格模式）
 *
 * 工作原理：通过 response_format.type='json_schema' + strict:true 强制模型输出
 * 符合指定 JSON Schema 的回复。支持此特性的模型：
 *
 * OpenAI 系列（来源：https://developers.openai.com/api/docs/guides/structured-outputs）：
 * - GPT-5 系列：gpt-5-*
 * - GPT-4.5：gpt-4.5-*
 * - GPT-4.1 系列：gpt-4.1-*, gpt-4.1-mini-*, gpt-4.1-nano-*
 * - GPT-4o 系列：gpt-4o-*, gpt-4o-mini-*
 * - GPT-4 Turbo：gpt-4-turbo-*
 * - o 系列推理模型：o1-*, o3-*, o4-mini-*
 *
 * 注意：response_format 与 tools 互斥，不能在同一个请求中同时使用。
 *
 * @param model 模型名称
 */
export function supportsStructuredOutput(model: string): boolean {
  return /^(gpt-5|gpt-4\.5|gpt-4\.1|gpt-4o|gpt-4-turbo|o[134])/.test(model)
}

/**
 * 检测当前模型是否支持 JSON 模式（response_format.json_object）
 *
 * 比 structured output 弱，不强制 schema，只保证输出是有效 JSON。
 * 字段结构需要由系统提示词指导。
 *
 * 已知支持的供应商：
 * - DeepSeek：所有 chat 模型（来源：https://api-docs.deepseek.com/guides/json_mode）
 *   deepseek-chat（V2/V3），deepseek-reasoner（R1），deepseek-v4-pro 等
 * - Together AI：JSON 模式（来源：https://docs.together.ai/docs/json-mode）
 * - xAI (Grok)：OpenAI 兼容的结构化输出（来源：https://docs.x.ai/docs/guides/structured-outputs）
 *
 * @param model 模型名称
 */
export function supportsJsonMode(_model: string): boolean {
  // deepseek 频繁触发空content异常，临时禁用
  // return /^(deepseek)/i.test(model)
  return false;
}

/**
 * 根据模型返回最适合的双语输出格式
 *
 * 优先级：
 * 1. json_schema 严格模式 → OpenAI 现代模型
 * 2. json_object 模式    → DeepSeek 等
 * 3. undefined           → 无 response_format，使用传统【】标记格式
 *
 * @param model 模型名称
 */
export function getBilingualResponseFormat(model: string): ResponseFormat | undefined {
  if (supportsStructuredOutput(model)) return BILINGUAL_OUTPUT_SCHEMA
  if (supportsJsonMode(model)) return { type: 'json_object' }
  return undefined
}

/**
 * 发送对话请求（流式），支持 Function Calling + 结构化输出 + 超时保护
 *
 * @param responseFormat 可选的结构化输出格式（与 tools 互斥，tools 优先）
 */
export async function chat(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  tools?: ToolDef[],
  responseFormat?: ResponseFormat,
): Promise<void> {
  const config = loadConfig()
  if (!isConfigValid(config)) {
    callbacks.onError(new Error('请先配置 API（右键 → 设置）'))
    return
  }

  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: 0.8,
    max_tokens: 4096,
  }
  if (tools?.length) {
    body.tools = tools
    log.debug('tools sent: %d', tools.length, tools.map(t => t.function.name))
  } else if (responseFormat) {
    // response_format 与 tools 互斥：有 tools 时不能用，无 tools 时可用
    body.response_format = responseFormat
    const detail = responseFormat.type === 'json_schema'
      ? 'json_schema(' + (responseFormat.json_schema?.name ?? '') + ')'
      : 'json_object'
    log.info('📐 response_format=%s (model=%s)', detail, config.model)
  }

  // 组合超时信号 + 外部取消信号
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), 120000) // 2 分钟全局超时
  const combinedSignal = signal ? combineAbortSignals(signal, timeoutController.signal) : timeoutController.signal

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const status = response.status
      let msg: string
      if (status === 401) msg = 'API Key 无效或已过期'
      else if (status === 429) msg = '请求过于频繁，请稍后重试'
      else if (status >= 500) msg = '服务端暂时不可用，请稍后重试'
      else msg = `API ${status}: ${errBody.slice(0, 200)}`
      throw new Error(msg)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('响应体不可读')

    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''
    let hasToolCalls = false
    // 累积 tool_calls (index → partial data)
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>()

    function flushToolCalls() {
      if (toolCallMap.size === 0) return
      const calls: ToolCallData[] = []
      for (const [, tc] of toolCallMap) {
        calls.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })
      }
      callbacks.onTools?.(calls)
      toolCallMap.clear()
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const choice = parsed.choices?.[0]
          const delta = choice?.delta ?? {}

          // ---- 思考内容 ----
          let reasoningContent = ''
          for (const key of ['reasoning_content', 'reasoning', 'think', 'thinking']) {
            const val = delta[key]
            if (typeof val === 'string' && val) { reasoningContent = val; break }
          }
          if (!reasoningContent && delta) {
            for (const key of Object.keys(delta)) {
              if (key === 'content' || key === 'role') continue
              const val = delta[key]
              if (typeof val === 'string' && val && !Array.isArray(delta[key]))
                { reasoningContent = val; break }
            }
          }
          if (reasoningContent) callbacks.onThinking?.(reasoningContent)

          // ---- 工具调用（流式 delta）----
          if (delta?.tool_calls) {
            hasToolCalls = true
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index ?? 0
              if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: '', name: '', args: '' })
              const entry = toolCallMap.get(idx)!
              if (tcDelta.id) entry.id = tcDelta.id
              if (tcDelta.function?.name) entry.name += tcDelta.function.name
              if (tcDelta.function?.arguments) entry.args += tcDelta.function.arguments
            }
          }

          // ---- 普通内容 ----
          const contentDelta = delta?.content ?? ''
          if (contentDelta) {
            fullText += contentDelta
            callbacks.onChunk(contentDelta)
          }
        } catch { /* skip parse errors */ }
      }
    }

    // 处理 buffer 中剩余的数据
    if (buffer.trim().startsWith('data: ')) {
      try {
        const parsed = JSON.parse(buffer.trim().slice(6))
        const delta = parsed.choices?.[0]?.delta ?? {}
        if (delta?.content) {
          fullText += delta.content
          callbacks.onChunk(delta.content)
        }
      } catch { /* ignore */ }
    }

    // 如果有工具调用，触发 onTools 并跳过 onDone
    if (hasToolCalls && toolCallMap.size > 0) {
      flushToolCalls()
      return // 不触发 onDone，由外层处理完工具后继续
    }

    callbacks.onDone(fullText)
  } catch (err) {
    clearTimeout(timeoutId)
    if ((err as Error).name === 'AbortError') {
      // 区分用户主动取消与全局超时：
      // - signal 是外部（用户）取消信号；若它已 abort → 用户取消，静默结束（仍以 AbortError 通知）
      // - 否则为 2 分钟全局超时 → 作为普通错误提示
      if (signal?.aborted) {
        const cancelErr = new Error('请求已取消')
        cancelErr.name = 'AbortError'
        callbacks.onError(cancelErr)
      } else {
        callbacks.onError(new Error('请求超时（已等待 2 分钟）'))
      }
      return
    }
    callbacks.onError(err as Error)
  }
}

/**
 * 非流式单次对话（用于格式修复等轻量场景）
 * 返回完整文本，不触发流式回调
 */
export async function quickChat(
  messages: ChatMessage[],
  signal?: AbortSignal,
  responseFormat?: ResponseFormat,
): Promise<string> {
  const config = loadConfig()
  if (!isConfigValid(config)) throw new Error('API 未配置')

  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.3,       // 低温度，更确定性的修复
    max_tokens: 4096,
  }
  if (responseFormat) {
    body.response_format = responseFormat
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), 60000)
  const combinedSignal = signal
    ? combineAbortSignals(signal, timeoutController.signal)
    : timeoutController.signal

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      throw new Error(`API ${response.status}: ${errBody.slice(0, 200)}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content ?? ''
  } catch (err) {
    if ((err as Error).name === 'AbortError') return ''
    throw err
  }
}

/**
 * 合并两个 AbortSignal，任一触发则合并信号触发。
 * 用于组合超时信号和用户取消信号。
 */
function combineAbortSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  s1.addEventListener('abort', onAbort, { once: true })
  s2.addEventListener('abort', onAbort, { once: true })
  // 如果任一已触发，立即同步
  if (s1.aborted || s2.aborted) controller.abort()
  return controller.signal
}
