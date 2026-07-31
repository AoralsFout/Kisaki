/**
 * AI API 客户端
 *
 * 使用 OpenAI 兼容格式，支持大多数 LLM Provider。
 * 支持流式输出 + Function Calling (Tool Use)。
 */
import type { AIConfig, ChatMessage, StreamCallbacks, ToolCallData, ResponseFormat } from './types'
import { getModelProfile } from './modelCapabilities'
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
import { encrypt, resolveStoredSecret } from '../utils/crypto'

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

  if (!config.apiKey) return config

  const resolved = await resolveStoredSecret(
    config.apiKey,
    (k) => k.startsWith('sk-') || k.length <= 20,
  )
  if (resolved.key === null) {
    // 密文损坏 / 主密钥丢失：清掉 Key，避免把乱码发给 API 造成 401；用户需重新填写
    log.error('API Key 解密失败，已清除失效配置，请重新填写')
    const cleaned = { ...config, apiKey: '' }
    saveConfig(cleaned)
    return cleaned
  }
  setDecryptedApiKeyCache(resolved.key)
  if (resolved.needsResave) {
    // 明文 / 旧格式密文 → 迁移为新格式（写回加密值，不写明文）
    const encryptedKey = await encrypt(resolved.key)
    saveConfig({ ...config, apiKey: encryptedKey })
  }
  return { ...config, apiKey: resolved.key }
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

// ─── 模型检测——委托给模型能力注册表 ────────────────────
// 说明见 modelCapabilities.ts

export {
  MAX_TOOL_TURNS,
  getModelProfile,
  getContextLimit,
  getMaxRounds,
} from './modelCapabilities'

/** 流式请求最大尝试次数（仅对「尚未收到任何内容」的瞬时失败重试） */
const MAX_STREAM_ATTEMPTS = 3
/** 重试退避基数（毫秒），第 n 次重试等待 base * n */
const RETRY_DELAY_BASE_MS = 600

/** 429 / 5xx 属于可重试的瞬时状态 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  // 必须走解密版：主窗口重启后解密缓存可能为空，
  // 直接 loadConfig() 会把 localStorage 里的密文当 Key 发给 API 造成 401。
  const config = await loadConfigSecure()
  if (!isConfigValid(config)) {
    callbacks.onError(new Error('请先配置 API（右键 → 设置）'))
    return
  }

  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const profile = getModelProfile(config.model)
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: 0.8,
    max_tokens: profile.recommendedMaxTokens,
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

  for (let attempt = 1; ; attempt++) {
    // 组合超时信号 + 外部取消信号（每个 attempt 独立超时；
    // 超时覆盖「等待响应 + 整个流式读取」全过程）
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), 120000) // 2 分钟
    const combinedSignal = signal
      ? combineAbortSignals(signal, timeoutController.signal)
      : timeoutController.signal
    /** 是否已收到任何内容（收到后不再重试，避免重复/错乱输出） */
    let receivedAny = false

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

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        const status = response.status
        let msg: string
        if (status === 401) msg = 'API Key 无效或已过期'
        else if (status === 429) msg = '请求过于频繁，请稍后重试'
        else if (status >= 500) msg = '服务端暂时不可用，请稍后重试'
        else msg = `API ${status}: ${errBody.slice(0, 200)}`
        // 瞬时错误（429 / 5xx）重试
        if (isRetryableStatus(status) && attempt < MAX_STREAM_ATTEMPTS) {
          clearTimeout(timeoutId)
          if (signal?.aborted) {
            const cancelErr = new Error('请求已取消')
            cancelErr.name = 'AbortError'
            callbacks.onError(cancelErr)
            return
          }
          await sleep(RETRY_DELAY_BASE_MS * attempt)
          continue
        }
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
        callbacks.onTools?.(calls, fullText)
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
              receivedAny = true
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
              receivedAny = true
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

      clearTimeout(timeoutId)

      // 如果有工具调用，触发 onTools 并跳过 onDone
      if (hasToolCalls && toolCallMap.size > 0) {
        flushToolCalls()
        return // 不触发 onDone，由外层处理完工具后继续
      }

      callbacks.onDone(fullText)
      return
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
      // 网络错误 / 流在收到任何内容前中断 → 可重试
      if (!receivedAny && attempt < MAX_STREAM_ATTEMPTS) {
        if (signal?.aborted) {
          const cancelErr = new Error('请求已取消')
          cancelErr.name = 'AbortError'
          callbacks.onError(cancelErr)
          return
        }
        await sleep(RETRY_DELAY_BASE_MS * attempt)
        continue
      }
      callbacks.onError(err as Error)
      return
    }
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
  const config = await loadConfigSecure()
  if (!isConfigValid(config)) throw new Error('API 未配置')

  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const profile = getModelProfile(config.model)
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.3,       // 低温度，更确定性的修复
    max_tokens: Math.min(profile.recommendedMaxTokens, 4096), // 修复场景不需要太长输出
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
    let response: Response
    for (let attempt = 1; ; attempt++) {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      })
      if (response.ok || attempt >= 2 || !isRetryableStatus(response.status)) break
      await sleep(RETRY_DELAY_BASE_MS * attempt)
    }
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
