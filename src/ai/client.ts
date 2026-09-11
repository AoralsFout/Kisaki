/**
 * AI API 客户端
 *
 * 使用 OpenAI 兼容格式，支持大多数 LLM Provider。
 * 支持流式输出 + Function Calling (Tool Use)。
 */
import type { AIConfig, ChatMessage, StreamCallbacks, ToolCallData, ResponseFormat, RequestTelemetry } from './types'
import { getModelProfile } from './modelCapabilities'
import { createLogger } from '../utils/logger'
import { RequestError, toRequestError } from '../application/net/requestError'
import {
  RequestExecutor,
  type RequestTelemetrySink,
} from '../application/net/requestExecutor'
import { fetchTransport } from '../infrastructure/net/fetchTransport'
import { readServerSentEvents } from '../infrastructure/net/serverSentEvents'

const log = createLogger('API')

/** 默认配置 */
export const DEFAULT_CONFIG: AIConfig = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  translationModel: '',
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
import { SecretBackedSettings } from '../application/settings/secretBackedSettings'
import { localSettingsStore } from '../infrastructure/settings/localSettingsStore'
import { secretStoreGateway } from '../utils/secretStore'

/** 保存的配置键名 */
const STORAGE_KEY = STORAGE_AI_CONFIG

const settings = new SecretBackedSettings<AIConfig>(localSettingsStore, secretStoreGateway, {
  storageKey: STORAGE_KEY,
  defaults: DEFAULT_CONFIG,
  secretKind: 'ai_api_key',
  looksPlaintext: key => key.startsWith('sk-') || key.length <= 20,
  telemetry: {
    secretMigrated: storage => log.debug('api.settings.debug', '配置中的 API Key 已迁移到更安全的存储', { storage }),
    secretUnavailable: reason => log.error(
      'api.load_config_secure.error',
      reason === 'transient'
        ? 'API Key 读取失败（瞬时），保留配置待重试'
        : 'API Key 无法读取（密钥链条目丢失或本地密文损坏），请重新配置',
      new Error(reason),
      { reason },
    ),
  },
})

export function loadConfig(): AIConfig { return settings.load() }

export function saveConfig(config: AIConfig): void { settings.save(config) }

/** 保存配置并加密 API Key */
export function saveConfigSecure(config: AIConfig): Promise<void> {
  return settings.saveSecure(config)
}

/** 加载配置并解密 API Key，自动迁移旧明文 */
export function loadConfigSecure(): Promise<AIConfig> {
  return settings.loadSecure()
}

export function isConfigValid(config: AIConfig): boolean {
  return Boolean(config.baseURL && config.apiKey && config.model)
}

/**
 * 用 OpenAI 兼容的 /models 端点验证地址与凭据，不产生对话费用。
 * 仅返回面向设置页的简短结果，不记录响应体或 API Key。
 */
export async function testAIConnection(config: AIConfig): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigValid(config)) return { ok: false, error: '配置不完整' }
  let base: URL
  try {
    base = new URL(config.baseURL.replace(/\/+$/, '') + '/models')
  } catch {
    return { ok: false, error: 'API 地址格式无效' }
  }

  try {
    return await requestExecutor.run<{ ok: boolean; error?: string }>({
      request: {
        url: base,
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}` },
      },
      transport: fetchTransport,
      policy: { label: 'ai.test_connection', timeoutMs: 15000 },
      consume: async response => {
        if (response.ok) return { ok: true }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: 'API Key 无效或无权访问' }
        }
        return { ok: false, error: `服务返回 HTTP ${response.status}` }
      },
    })
  } catch (error) {
    const failure = toRequestError(error)
    if (failure.kind === 'timeout') return { ok: false, error: '连接超时' }
    return { ok: false, error: failure.message || '网络连接失败' }
  }
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

/** 模型接口错误 → 面向用户的简短提示 */
function modelErrorMessage(status: number): string {
  if (status === 401) return 'API Key 无效或已过期'
  if (status === 429) return '请求过于频繁，请稍后重试'
  if (status >= 500) return '服务端暂时不可用，请稍后重试'
  return `API ${status}: 请求失败`
}

const telemetry: RequestTelemetrySink = {
  attemptFailed: event => log.warn(
    'api.request_retry',
    `请求失败，准备第 ${event.attempt} 次重试`,
    event.error,
    { kind: event.error.kind, status: event.error.status, attempt: event.attempt },
  ),
  completed: () => {},
}

/** 出站请求的统一执行器：超时、重试、取消与失败分类都在这里。 */
const requestExecutor = new RequestExecutor(telemetry)

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
  telemetry: RequestTelemetry = {},
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
    log.debug("api.chat.debug", `tools sent: ${tools.length}`, { ...telemetry, tools_length: tools.length, tools_map: tools.map(t => t.function.name) })
  } else if (responseFormat) {
    // response_format 与 tools 互斥：有 tools 时不能用，无 tools 时可用
    body.response_format = responseFormat
    const detail = responseFormat.type === 'json_schema'
      ? 'json_schema(' + (responseFormat.json_schema?.name ?? '') + ')'
      : 'json_object'
    log.info("api.chat.info", `📐 response_format=${detail} (model=${config.model})`, { ...telemetry, detail: detail, config_model: config.model })
  }

  try {
    await requestExecutor.run<void>({
      request: {
        url,
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body,
      },
      transport: fetchTransport,
      policy: {
        label: 'ai.chat',
        // 2 分钟，覆盖「等待响应 + 整个流式读取」全过程
        timeoutMs: 120000,
        maxAttempts: MAX_STREAM_ATTEMPTS,
        backoffBaseMs: RETRY_DELAY_BASE_MS,
      },
      signal,
      consume: async response => {
        if (!response.ok) {
          const errBody = await response.text().catch(() => '')
          log.sensitiveDebug('api.error_response_sensitive.debug', '模型接口错误响应片段', {
            ...telemetry,
            status: response.status,
            body: errBody.slice(0, 200),
          })
          throw new RequestError('http', modelErrorMessage(response.status), {
            status: response.status,
            retryable: false,
          })
        }

        const reader = response.body?.getReader()
        if (!reader) throw new RequestError('response', '响应体不可读', { retryable: false })

        /** 是否已收到任何内容（收到后不再重试，避免重复/错乱输出） */
        let receivedAny = false

        try {
          let fullText = ''
          let hasToolCalls = false
          // 累积 tool_calls (index → partial data)
          const toolCallMap = new Map<number, { id: string; name: string; args: string }>()

          function snapshotToolCalls(): ToolCallData[] {
            const calls: ToolCallData[] = []
            for (const [, tc] of toolCallMap) {
              calls.push({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.args },
              })
            }
            return calls
          }

          function flushToolCalls() {
            if (toolCallMap.size === 0) return
            callbacks.onTools?.(snapshotToolCalls(), fullText)
            toolCallMap.clear()
          }

          for await (const data of readServerSentEvents(reader)) {
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
                callbacks.onToolCallDelta?.(snapshotToolCalls())
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

          // 如果有工具调用，触发 onTools 并跳过 onDone
          if (hasToolCalls && toolCallMap.size > 0) {
            flushToolCalls()
            return // 不触发 onDone，由外层处理完工具后继续
          }

          callbacks.onDone(fullText)
        } catch (cause) {
          if (cause instanceof RequestError) throw cause
          // 网络错误 / 流在收到任何内容前中断 → 可重试；
          // 已经产出过内容则不再重试，避免重复或错乱输出。
          throw new RequestError('network', (cause as Error)?.message || String(cause), {
            retryable: !receivedAny,
            cause,
          })
        }
      },
    })
  } catch (error) {
    // 流在收到任何内容前中断才可重试；已收到内容则直接失败，避免重复输出。
    const failure = error instanceof RequestError
      ? error
      : new RequestError('network', (error as Error)?.message || String(error), {
        retryable: false,
        cause: error,
      })
    // 区分用户主动取消与全局超时：
    // - signal 是外部（用户）取消信号；若它已 abort → 用户取消，静默结束（仍以 AbortError 通知）
    // - 否则为 2 分钟全局超时 → 作为普通错误提示
    if (failure.kind === 'cancelled') {
      const cancelErr = new Error('请求已取消')
      cancelErr.name = 'AbortError'
      callbacks.onError(cancelErr)
      return
    }
    if (failure.kind === 'timeout') {
      callbacks.onError(new Error('请求超时（已等待 2 分钟）'))
      return
    }
    callbacks.onError(failure)
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
  telemetry: RequestTelemetry = {},
): Promise<string> {
  const config = await loadConfigSecure()
  if (!isConfigValid(config)) throw new Error('API 未配置')

  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const quickModel = config.translationModel?.trim() || config.model
  const profile = getModelProfile(quickModel)
  const body: Record<string, unknown> = {
    model: quickModel,
    messages,
    temperature: 0.3,       // 低温度，更确定性的修复
    max_tokens: Math.min(profile.recommendedMaxTokens, 4096), // 修复场景不需要太长输出
  }
  if (responseFormat) {
    body.response_format = responseFormat
  }
  log.debug('api.quick_chat_started', '轻量模型请求开始', {
    ...telemetry,
    model: quickModel,
    message_count: messages.length,
    response_format: responseFormat?.type,
  })

  try {
    return await requestExecutor.run<string>({
      request: {
        url,
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body,
      },
      transport: fetchTransport,
      policy: {
        label: 'ai.quick_chat',
        timeoutMs: 60000,
        maxAttempts: 2,
        backoffBaseMs: RETRY_DELAY_BASE_MS,
      },
      signal,
      consume: async response => {
        if (!response.ok) {
          const errBody = await response.text().catch(() => '')
          log.sensitiveDebug('api.quick_chat_error_sensitive.debug', '轻量模型错误响应片段', {
            ...telemetry,
            status: response.status,
            body: errBody.slice(0, 200),
          })
          throw new RequestError('http', `API ${response.status}: 请求失败`, {
            status: response.status,
            retryable: false,
          })
        }

        const data = await response.json<{ choices?: { message?: { content?: string } }[] }>()
        const content = data.choices?.[0]?.message?.content ?? ''
        log.debug('api.quick_chat_completed', '轻量模型请求完成', {
          ...telemetry,
          model: quickModel,
          result_length: content.length,
        })
        return content
      },
    })
  } catch (error) {
    const failure = toRequestError(error, { callerAborted: signal?.aborted === true })
    // 取消与超时都按「无结果」返回，由调用方决定后续处理
    if (failure.kind === 'cancelled' || failure.kind === 'timeout') return ''
    log.warn('api.quick_chat_failed', '轻量模型请求失败', failure, { ...telemetry })
    throw failure
  }
}
