/**
 * AI API 客户端
 *
 * 使用 OpenAI 兼容格式，支持大多数 LLM Provider。
 * 支持流式输出 + Function Calling (Tool Use)。
 */
import type { AIConfig, ChatMessage, StreamCallbacks, ToolCallData } from './types'
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
      saveConfig({ ...config, apiKey: decrypted })
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

export function isConfigValid(config: AIConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model)
}

/**
 * 发送对话请求（流式），支持 Function Calling + 超时保护
 */
export async function chat(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  tools?: ToolDef[],
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
    if ((err as Error).name === 'AbortError') {
      callbacks.onDone('')
      return
    }
    clearTimeout(timeoutId)
    callbacks.onError(err as Error)
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
