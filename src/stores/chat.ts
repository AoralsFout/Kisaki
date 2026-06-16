/**
 * 对话状态管理（Pinia）
 *
 * ═══ 调试信息说明 ═══
 * 本文件包含完整的执行过程调试日志，按级别分类：
 *   log.trace() — 最细粒度追踪（函数入口/出口、循环迭代、每步状态快照）
 *   log.debug() — 详细调试信息（解析过程、工具调用细节、计时数据）
 *   log.info()  — 重要流程节点（消息收发、配置变更、错误恢复）
 *   log.warn()  — 异常但不中断（降级、修复尝试、边界情况）
 *   log.error() — 可恢复错误（API异常、解析失败、执行异常）
 *
 * 调试信息统一格式：
 *   [函数名] 操作描述 — 关键数据摘要
 *   ▶ 函数入口 / ◀ 函数出口 / ⚡ 状态变更 / ⏱ 耗时 / ⚠ 警告
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chat, quickChat, isConfigValid, loadConfig, ChatContext, supportsStructuredOutput, supportsJsonMode, getBilingualResponseFormat, getToolTurns } from '../ai'
import type { ToolCallData, ResponseFormat } from '../ai'
import { agentService } from '../agent/service'
import type { ToolCall } from '../agent'
import { speakTextStreaming, cancelSpeak } from '../tts'
import { useCharacterStore } from '../character'
import { createLogger } from '../utils/logger'
import { t } from '../i18n'
import { useSessionStore } from './session'
import { DEFAULT_VOICE_LANGUAGE } from '../constants'
import { resolveDisplayLanguage } from './language'

const log = createLogger('ChatStore')

// ─── 调试计时器工具 ────────────────────────────────────
/**
 * 创建一个命名的计时器，用于测量异步操作耗时。
 * 调用 stop() 返回毫秒数并自动 log。
 *
 * @example
 *   const timer = debugTimer('AI回复')
 *   const result = await someAsyncOp()
 *   timer.stop()                // → trace: "[AI回复] 耗时: 1234ms"
 *   timer.stop('含重试')        // → trace: "[AI回复] 含重试 耗时: 1234ms"
 */
function debugTimer(label: string) {
  const start = performance.now()
  let stopped = false
  return {
    stop: (suffix?: string) => {
      if (stopped) return 0
      stopped = true
      const elapsed = Math.round(performance.now() - start)
      const tag = suffix ? ` ${suffix}` : ''
      log.trace('[⏱Timer] %s%s: %dms', label, tag, elapsed)
      return elapsed
    },
    lap: (tag: string) => {
      const elapsed = Math.round(performance.now() - start)
      log.trace('[⏱Lap] %s — %s: %dms', label, tag, elapsed)
      return elapsed
    },
  }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 思考/推理过程内容 */
  thinking?: string
  timestamp: number
}

/** 一次 chat() 调用的结果 */
type ChatResult =
  | { type: 'done'; text: string }
  | { type: 'tools'; calls: ToolCallData[] }

/** 双语回复的语言标签匹配模式（增强容错） */
const NATIVE_RE = /【([^】]+)】\s*([\s\S]*?)(?=\s*【译文】|$)/
const DISPLAY_RE = /【译文】\s*([\s\S]*?)$/

/** 备用匹配：宽松模式，处理可能使用 [] 或 () 或其它变体的情况 */
const FALLBACK_NATIVE_RE = /\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*([\s\S]*?)(?=\s*\[{1,2}\s*译文\s*\]{1,2}|$)/
const FALLBACK_DISPLAY_RE = /\[{1,2}\s*译文\s*\]{1,2}\s*([\s\S]*?)$/

/**
 * 解析 AI 回复中的双语内容
 * 格式：
 *   【日语】こんにちは
 *   【译文】你好
 *
 * 如果解析失败则整段文本同时用作显示和 TTS
 *
 * @internal 导出以支持单元测试
 */
export function parseBilingualResponse(text: string): { nativeText: string; displayText: string } {
  // 1. 标准格式【】匹配
  const nativeMatch = text.match(NATIVE_RE)
  const displayMatch = text.match(DISPLAY_RE)

  if (nativeMatch && displayMatch) {
    const nativeText = nativeMatch[2].trim()
    const displayText = displayMatch[1].trim()
    if (nativeText && displayText) {
      return { nativeText, displayText }
    }
  }

  // 2. 如果标准匹配到但内容为空，尝试用备用匹配（[] 等变体）
  const fallbackNative = text.match(FALLBACK_NATIVE_RE)
  const fallbackDisplay = text.match(FALLBACK_DISPLAY_RE)
  if (fallbackNative && fallbackDisplay) {
    const nativeText = fallbackNative[2].trim()
    const displayText = fallbackDisplay[1].trim()
    if (nativeText && displayText) {
      return { nativeText, displayText }
    }
  }

  // 3. 如果 NATIVE_RE 只匹配到【标签】但没有【译文】，检查是否已包含译文内容
  if (nativeMatch && !displayMatch) {
    const nativeText = nativeMatch[2].trim()
    const rest = text.slice(nativeMatch[0].length).trim()
    // 如果剩余内容看起来像是译文（以【译文】开头或者只是一段不同的文本）
    if (rest && rest !== nativeText) {
      return { nativeText, displayText: rest }
    }
  }

  // 4. 没有【译文】标签但可能是纯母语回复（语音=显示语言的情况）
  // 此时整段文本同时用于显示和播报
  return { nativeText: text, displayText: text }
}

/**
 * 尝试从 JSON 结构化输出中提取双语内容
 * 适用于支持 response_format 的 provider（如 GPT-4o-mini）
 * 格式：{"native_text": "...", "display_text": "..."}
 *
 * 如果解析失败返回 null，由调用方降级到 parseBilingualResponse
 */
export function tryParseStructuredOutput(text: string): { nativeText: string; displayText: string } | null {
  try {
    const parsed = JSON.parse(text.trim())
    if (parsed && typeof parsed === 'object') {
      const nativeText = parsed.native_text?.trim()
      const displayText = parsed.display_text?.trim()
      if (nativeText && displayText) {
        return { nativeText, displayText }
      }
    }
  } catch {
    // 解析失败，非 JSON 格式
  }
  return null
}

/**
 * 当格式解析失败时，尝试让 AI 自行修复回复的格式
 * 使用非流式调用 + 低温度，尽量减少延迟和成本
 * @param originalText 模型原始回复
 * @param voiceLang 角色语音语言（如 "ja-JP"）
 * @param displayLang 用户显示语言（如 "zh-CN"）
 * @param signal 可选取消信号
 * @returns 修复后的格式化文本，若修复失败则返回空字符串
 */
async function attemptFormatRepair(
  originalText: string,
  voiceLang: string,
  _displayLang: string,
  signal?: AbortSignal,
): Promise<string> {
  const langNames: Record<string, string> = {
    'zh-CN': '中文（简体）',
    'zh-TW': '中文（繁体）',
    'en-US': '英语',
    'ja-JP': '日语',
    'ko-KR': '韩语',
    'fr-FR': '法语',
    'de-DE': '德语',
    'es-ES': '西班牙语',
    'ru-RU': '俄语',
  }
  const voiceName = langNames[voiceLang] || voiceLang

  try {
    const fixed = await quickChat(
      [
        {
          role: 'system',
          content: `你是一个格式修正助手。用户的回复没有遵循要求的双语格式。

要求格式：
【${voiceName}】<角色母语内容>
【译文】<用户语言内容>

注意：
1 - 角色母语内容只包含可以直接读出的自然语言，不能有特殊符号，不能有描述性语言。
2 - 译文保留完整内容。

请将以下回复重新组织成上面的格式。只输出修正后的文本，不要任何额外说明。`,
        },
        { role: 'user', content: originalText },
      ],
      signal,
    )
    // 验证修正结果是否可解析
    const parsed = parseBilingualResponse(fixed)
    if (parsed.nativeText && parsed.displayText && parsed.nativeText !== parsed.displayText) {
      log.info('格式修复成功: %d 字符 → %d 字符', originalText.length, fixed.length)
      return fixed
    }
    // 修复结果同样不可用
    log.warn('格式修复结果仍无效，放弃重试')
    return ''
  } catch (err) {
    log.warn('格式修复请求失败: %s', (err as Error).message)
    return ''
  }
}

/** 包装 chat() 为 Promise 返回 */
function chatOnce(
  messages: ReturnType<ChatContext['getMessages']>,
  tools: any[],
  signal: AbortSignal,
  callbacks: { onThinking: (t: string) => void; onChunk: (t: string) => void },
  responseFormat?: ResponseFormat,
): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    chat(
      messages,
      {
        onChunk: callbacks.onChunk,
        onThinking: callbacks.onThinking,
        onTools: (calls) => {
          resolve({ type: 'tools', calls })
        },
        onDone: (text) => {
          resolve({ type: 'done', text })
        },
        onError: (err) => {
          reject(err)
        },
      },
      signal,
      tools,
      responseFormat,
    )
  })
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const isProcessing = ref(false)
  const currentBubbleText = ref('')
  const currentThinking = ref('')
  const isTyping = ref(false)
  const showBubble = ref(false)
  const showInput = ref(false)
  const configReady = ref(false)
  /** 当前是否正在执行工具（子状态） */
  const isUsingTools = ref(false)

  /**
   * 根据当前配置创建一个按模型能力自动配置的 ChatContext。
   * 后续若要切换模型，需重新创建 ChatContext 使其生效。
   */
  function createChatContext(): ChatContext {
    const cfg = loadConfig()
    if (cfg.model) {
      return new ChatContext({ model: cfg.model })
    }
    return new ChatContext()
  }

  let chatContext = createChatContext()
  let abortController: AbortController | null = null

  function init() {
    log.trace('[init] ▶')
    const timer = debugTimer('init')
    const cfg = loadConfig()
    const valid = isConfigValid(cfg)
    configReady.value = valid
    log.info('[init] ChatStore 初始化, 配置%s就绪', valid ? '' : '未')
    log.debug('[init] 配置详情: model=%s baseURL=%s hasKey=%s',
      cfg.model || '(未设置)',
      cfg.baseURL || '(默认)',
      cfg.apiKey ? '✓' : '✗')
    log.trace('[init] configReady → %s', valid)
    timer.stop()
    log.trace('[init] ◀')
  }

  /** 发送消息给 AI（支持工具调用循环） */
  async function sendMessage(text: string) {
    const _fn = 'sendMessage'
    const _timer = debugTimer(_fn)
    log.trace('[%s] ▶ text="%s"', _fn, text?.slice(0, 50))

    // ── 守卫条件检查 ────────────────────────────────────
    if (isProcessing.value) {
      log.warn('[%s] ⚠ 正在处理中，忽略重复请求 (text=%s)', _fn, text?.slice(0, 30))
      return
    }
    if (!text || !text.trim()) {
      log.warn('[%s] ⚠ 收到空消息，忽略', _fn)
      return
    }

    const userText = text.trim()
    isProcessing.value = true
    log.debug('[%s] isProcessing → true', _fn)

    // 用户发送新消息时，取消正在播放的语音
    log.trace('[%s] 取消正在播放的语音', _fn)
    cancelSpeak()

    if (!navigator.onLine) {
      log.warn('[%s] ✗ 网络不可用，无法发送消息', _fn)
      log.debug('[%s] navigator.onLine=%s', _fn, navigator.onLine)
      showBubbleText(t('app.bubble.networkOff'), false)
      isProcessing.value = false
      log.trace('[%s] ◀ (网络不可用)', _fn)
      return
    }

    const cfgCheck = loadConfig()
    if (!isConfigValid(cfgCheck)) {
      log.warn('[%s] ✗ API 未配置 (model=%s baseURL=%s hasKey=%s)',
        _fn, cfgCheck.model || '?', cfgCheck.baseURL || '?', cfgCheck.apiKey ? '✓' : '✗')
      showBubbleText(t('app.bubble.apiNotConfigured'), false)
      isProcessing.value = false
      log.trace('[%s] ◀ (配置无效)', _fn)
      return
    }

    log.info('[%s] 用户消息: "%s"', _fn, userText.slice(0, 100))
    log.debug('[%s] 消息长度: %d 字符', _fn, userText.length)

    // ── 添加用户消息 ────────────────────────────────────
    addMessage('user', userText)
    chatContext.addUserMessage(userText)
    log.trace('[%s] 用户消息已加入 ChatContext', _fn)

    // ── 准备气泡 ────────────────────────────────────────
    showBubble.value = true
    currentBubbleText.value = ""
    isTyping.value = false
    currentThinking.value = ''
    log.trace('[%s] 气泡状态: showBubble=true text="" isTyping=false', _fn)

    // ── 同步角色数据到 agent 上下文 ─────────────────────
    {
      const charStore = useCharacterStore()
      if (charStore.data) {
        agentService.syncCharacterData(charStore.data)
        log.trace('[%s] 角色数据已同步到 agent 上下文 (voice=%s lang=%s)',
          _fn, charStore.data.voice || '?', charStore.data.voiceLanguage || '?')
      } else {
        log.trace('[%s] 无角色数据可同步', _fn)
      }
    }

    // ── 收集工具定义 ────────────────────────────────────
    const tools = agentService.getToolDefinitions()
    log.debug('[%s] 工具定义数量: %d', _fn, tools.length)
    if (tools.length > 0) {
      const toolNames = tools.map(t => t.function?.name || '(unnamed)').join(', ')
      log.debug('[%s] 工具列表: [%s]', _fn, toolNames)
    }

    // ── 检测 JSON 格式支持 ───────────────────────────────
    const config = loadConfig()
    const strictOk = supportsStructuredOutput(config.model)
    const jsonOk = supportsJsonMode(config.model)
    const canUseJson = strictOk || jsonOk
    log.debug('[%s] 模型=%s strict=%s json=%s canUseJson=%s',
      _fn, config.model, strictOk, jsonOk, canUseJson)
    if (canUseJson) {
      const mode = strictOk ? 'json_schema(严格)' : 'json_object(宽松)'
      log.info('[%s] [结构化输出] 模型=%s 模式=%s', _fn, config.model, mode)
      chatContext.setStructuredOutput(true)
    } else {
      log.info('[%s] [结构化输出] 模型不支持 (model=%s)', _fn, config.model)
    }

    // 本次请求独享的 AbortController。后续始终引用 myAbort（而非可能被新请求/取消
    // 改写的模块级 abortController），避免并发请求互相干扰。
    const myAbort = new AbortController()
    abortController = myAbort
    let thinkSplitDone = false
    let finalTextFromLoop: string | null = null  // 追踪循环是否产生最终文本
    let wasCancelled = false                      // 用户主动取消标记（跳过兜底气泡）

    // ── 工具调用循环 ─────────────────────────────────────
    // 根据模型智能层级动态决定循环上限（更智能的模型需要的修复轮次更少）
    const toolTurns = getToolTurns(config.model)
    log.trace('[%s] 工具循环开始 toolTurns=%d (model=%s)', _fn, toolTurns, config.model)
    for (let turn = 0; turn < toolTurns; turn++) {
      log.trace('[%s] ——— 第 %d/%d 轮 ———', _fn, turn + 1, toolTurns)
      const turnTimer = debugTimer(`${_fn} turn#${turn}`)

      // 结构化输出与 tools 互斥：只在无工具轮次启用
      const turnHasTools = turn === 0 && tools.length > 0
      const rf = !turnHasTools && canUseJson ? getBilingualResponseFormat(config.model) : undefined

      log.trace('[%s] 第%d轮: turnHasTools=%s rf=%s', _fn, turn, turnHasTools, rf?.type || 'none')
      if (rf) {
        log.info('[%s] 第%d轮: 使用 response_format=%s schema=%s', _fn, turn, rf.type,
          (rf as any).json_schema?.name || '-')
      } else if (turnHasTools) {
        log.info('[%s] 第%d轮: tools=%d 个启用 → 跳过 response_format', _fn, turn, tools.length)
      } else {
        log.info('[%s] 第%d轮: 纯文本模式（无 tools 无 response_format）', _fn, turn)
      }

      try {
        let contentBuffer = ""  // 单轮缓冲区：累积完整内容后统一解析
        const chatTimer = debugTimer(`${_fn} chatOnce turn#${turn}`)
        log.trace('[%s] 第%d轮 chat() 发起请求...', _fn, turn)

        // 流式回调（提取出来以便重试时复用）
        const streamCallbacks = {
          onChunk: (delta: string) => {
            contentBuffer += delta
            // 仍从内容中提取 thinking（如 <think> 标签）用于实时显示
            if (!thinkSplitDone) {
              const full = contentBuffer
              const match = full.match(/^([\s\S]*?)<\/think>\s*([\s\S]*)$/)
              if (match) {
                const think = match[1].replace(/^<think>\s*/, '')
                if (think) {
                  currentThinking.value = think
                  log.debug('[%s] 第%d轮 <think> 标签检测到，提取 %d 字符', _fn, turn, think.length)
                }
                thinkSplitDone = true
                log.trace('[%s] 第%d轮 thinkSplitDone → true', _fn, turn)
                return
              }
              if (full.includes('<think>') && !full.includes('</think>')) {
                currentThinking.value = full.replace(/^[\s\S]*?<think>\s*/, '')
                log.trace('[%s] 第%d轮 thinking 累积中 (%d 字符)', _fn, turn, currentThinking.value.length)
                return
              }
            }
          },
          onThinking: (t: string) => {
            currentThinking.value += t
            log.trace('[%s] onThinking 收到 %d 字符，累积 %d 字符', _fn, t.length, currentThinking.value.length)
          },
        }

        let result = await chatOnce(
          chatContext.getMessages(),
          turnHasTools ? tools : [],
          myAbort.signal,
          streamCallbacks,
          rf,
        )
        chatTimer.stop()

        // DeepSeek JSON 模式空 content 重试（一次）
        // DeepSeek 在使用 json_object 时有概率返回空的 content 字段
        // 参考：https://api-docs.deepseek.com/guides/json_mode
        if (result.type === 'done' && !result.text?.trim() && jsonOk) {
          log.warn('[%s] 第%d轮 ⚠ DeepSeek JSON 模式返回空内容，重试一次...', _fn, turn)
          contentBuffer = ''
          thinkSplitDone = false
          result = await chatOnce(
            chatContext.getMessages(),
            turnHasTools ? tools : [],
            myAbort.signal,
            streamCallbacks,
            rf,
          )
          chatTimer.stop('含重试')
        }

        if (result.type === 'done') {
          const finalText = result.text
          finalTextFromLoop = finalText

          log.info('[%s] 第%d轮 AI 回复完成, 长度=%d', _fn, turn, finalText?.length || 0)
          log.debug('[%s] AI 回复前200字: "%s"', _fn, (finalText || '').slice(0, 200))

          // 兜底：检测 AI 文本中是否包含工具调用（不支持原生 FC 的模型会把调用写在文字里）
          const textCallsTimer = debugTimer(`${_fn} textToolCalls turn#${turn}`)
          const textCalls = agentService.extractTextToolCalls(finalText)
          textCallsTimer.stop()
          if (textCalls.length > 0) {
            log.info('[%s] 第%d轮 ✦ 文本工具调用检测: %d 个', _fn, turn, textCalls.length)
            const tcNames = textCalls.map(tc => tc.name || '(unnamed)').join(', ')
            log.debug('[%s] 第%d轮 ✦ 工具列表: [%s]', _fn, turn, tcNames)

            isUsingTools.value = true
            currentBubbleText.value = ""
            // 将 AI 回复（不含工具调用部分）加入上下文
            const cleanText = agentService.stripTextToolCalls(finalText)
            log.trace('[%s] 第%d轮 strip 后文本长度=%d', _fn, turn, cleanText?.length || 0)
            if (cleanText) {
              chatContext.addAssistantMessage(cleanText)
              log.trace('[%s] 第%d轮 清洗后文本已加入 ChatContext', _fn, turn)
            }

            // 依次执行工具
            log.trace('[%s] 第%d轮 ✦ 开始顺序执行 %d 个文本工具', _fn, turn, textCalls.length)
            for (let ti = 0; ti < textCalls.length; ti++) {
              const tc = textCalls[ti]
              const toolTimer = debugTimer(`${_fn} textTool#${ti} turn#${turn}`)
              const tcName = tc.name || '?'
              log.info('[%s] 第%d轮 ✦ 执行文本工具[%d/%d]: %s', _fn, turn, ti + 1, textCalls.length, tcName)
              log.debug('[%s] 第%d轮 ✦ 工具参数: %O', _fn, turn, tc.arguments)
              const toolResult = await agentService.execute(tc)
              toolTimer.stop()
              log.debug('[%s] 第%d轮 ✦ 工具结果: %s', _fn, turn,
                (toolResult?.content || '').slice(0, 150))
              chatContext.addToolResult(tc.id, toolResult.content)
              log.trace('[%s] 第%d轮 ✦ 工具结果已加入 ChatContext', _fn, turn)
            }
            isUsingTools.value = false
            turnTimer.stop(`tools → continue`)
            log.info('[%s] 第%d轮 ✦ 文本工具执行完毕，进入下一轮', _fn, turn)
            continue // 继续请求 AI 生成最终回复
          }
          log.trace('[%s] 第%d轮 无文本工具调用', _fn, turn)

          // 正常文本回复 — 解析双语内容
          if (finalText) {
            // 如果启用了 JSON 格式输出，优先尝试 JSON 解析
            let parsed: { nativeText: string; displayText: string } | null = null
            let parseMethod = '标记格式【】'
            const parseTimer = debugTimer(`${_fn} parse turn#${turn}`)

            if (canUseJson) {
              log.trace('[%s] 第%d轮 尝试 JSON 结构化解析...', _fn, turn)
              parsed = tryParseStructuredOutput(finalText)
              parseTimer.lap('JSON解析')
              if (parsed) {
                parseMethod = 'JSON结构化输出'
                log.info('[%s] 第%d轮 ✓ JSON 结构化解析成功: native=%d字 display=%d字',
                  _fn, turn, parsed.nativeText.length, parsed.displayText.length)
              } else {
                log.warn('[%s] 第%d轮 ✗ JSON 解析失败，降级到标记格式 (文本前60字: "%s")',
                  _fn, turn, finalText.slice(0, 60))
              }
            }

            // JSON 解析失败或未启用结构化 → 降级到标记格式解析
            if (!parsed) {
              log.trace('[%s] 第%d轮 尝试标记格式解析【】...', _fn, turn)
              parsed = parseBilingualResponse(finalText)
              parseTimer.lap('标记解析')
              log.debug('[%s] 第%d轮 标记解析结果: native="%s" display="%s"',
                _fn, turn, (parsed.nativeText || '').slice(0, 40), (parsed.displayText || '').slice(0, 40))
            }

            let { nativeText, displayText } = parsed
            parseTimer.stop()
            log.debug('[%s] 第%d轮 解析结果: native=%d字 display=%d字 parseMethod=%s',
              _fn, turn, nativeText.length, displayText.length, parseMethod)

            // 格式恢复：当语言不同但解析结果相同时（AI 忘记双语格式），
            // 自动发起一次修复请求
            if (nativeText === displayText) {
              const charStore = useCharacterStore()
              const vLang = charStore.data?.voiceLanguage || DEFAULT_VOICE_LANGUAGE
              const dLang = resolveDisplayLanguage(charStore.data?.textLanguage)
              log.info('[%s] 第%d轮 ⚠ nativeText === displayText (%d字), 检查是否需修复 (语音=%s, 显示=%s)',
                _fn, turn, nativeText.length, vLang, dLang)
              if (vLang !== dLang) {
                log.warn('[%s] 第%d轮 ⚠ 双语格式未遵守，尝试修复 (语音=%s, 显示=%s)',
                  _fn, turn, vLang, dLang)
                log.debug('[%s] 第%d轮 原始文本: "%s"', _fn, turn, finalText.slice(0, 200))
                // 标记格式违规，下次请求将重新附上完整格式指令而非简短提醒
                chatContext.markFormatViolation()
                const repairTimer = debugTimer(`${_fn} formatRepair turn#${turn}`)
                const repaired = await attemptFormatRepair(finalText, vLang, dLang, myAbort.signal)
                repairTimer.stop()
                if (repaired) {
                  log.info('[%s] 第%d轮 ✓ 格式修复成功 (%d→%d字)',
                    _fn, turn, finalText.length, repaired.length)
                  log.trace('[%s] 第%d轮 修复后文本: "%s"', _fn, turn, repaired.slice(0, 150))
                  const repairedParsed = tryParseStructuredOutput(repaired) ?? parseBilingualResponse(repaired)
                  nativeText = repairedParsed.nativeText
                  displayText = repairedParsed.displayText
                  log.debug('[%s] 第%d轮 修复后解析: native=%d字 display=%d字',
                    _fn, turn, nativeText.length, displayText.length)
                } else {
                  log.warn('[%s] 第%d轮 ✗ 格式修复失败或无效，使用原始文本', _fn, turn)
                }
              } else {
                log.debug('[%s] 第%d轮 语言相同(v=%s d=%s)，跳过修复', _fn, turn, vLang, dLang)
              }
            }

            chatContext.addAssistantMessage(displayText)
            addMessage('assistant', displayText, currentThinking.value)
            log.info('[%s] 第%d轮 ✓ AI 回复完成 [解析:%s] (显示:%d字, TTS:%d字)',
              _fn, turn, parseMethod, displayText.length, nativeText.length)
            log.debug('[%s] 第%d轮 显示文本: "%s"', _fn, turn, displayText.slice(0, 100))
            log.debug('[%s] 第%d轮 TTS文本: "%s"', _fn, turn, nativeText.slice(0, 100))
            if (currentThinking.value) {
              log.debug('[%s] 第%d轮 thinking: "%s"', _fn, turn, currentThinking.value.slice(0, 100))
            }

            // TTS 播报使用角色母语文本
            triggerTts(nativeText)

            // 气泡输出：非流式，等待结构化解析成功后以打字机动画显示文本
            currentBubbleText.value = displayText
            isTyping.value = true
            log.trace('[%s] 第%d轮 气泡文本已设置 (%d字) typing=%s',
              _fn, turn, displayText.length, isTyping.value)
          } else {
            log.warn('[%s] 第%d轮 ⚠ AI 返回空文本', _fn, turn)
          }
          turnTimer.stop('done — break')
          log.trace('[%s] 第%d轮 ◀ (break from loop)', _fn, turn)
          break
        }

        if (result.type === 'tools') {
          const toolCalls = result.calls
          log.info('[%s] 第%d轮 ★ 原生工具调用: %d 个', _fn, turn, toolCalls.length)
          const tcNames = toolCalls.map(tc => tc.function?.name || '(unnamed)').join(', ')
          log.debug('[%s] 第%d轮 ★ 工具列表: [%s]', _fn, turn, tcNames)

          // 执行工具
          isUsingTools.value = true
          currentBubbleText.value = ""
          log.trace('[%s] 第%d轮 isUsingTools=true bubble=clear', _fn, turn)

          // 将 tool_calls 加入上下文
          chatContext.addAssistantToolCall(result.calls)
          log.trace('[%s] 第%d轮 ★ %d 个 tool_calls 已加入 ChatContext', _fn, turn, toolCalls.length)

          // 按顺序执行工具（大部分工具串行执行更安全）
          log.trace('[%s] 第%d轮 ★ 开始顺序执行 %d 个工具', _fn, turn, toolCalls.length)
          for (let ti = 0; ti < toolCalls.length; ti++) {
            const tc = toolCalls[ti]
            const toolTimer = debugTimer(`${_fn} tool#${ti} turn#${turn}`)
            const tcName = tc.function?.name || '?'
            log.info('[%s] 第%d轮 ★ 执行工具[%d/%d]: %s (id=%s)',
              _fn, turn, ti + 1, toolCalls.length, tcName, tc.id)
            log.debug('[%s] 第%d轮 ★ 工具参数: %s', _fn, turn,
              (tc.function?.arguments || '{}').slice(0, 300))
            let toolCall: ToolCall
            try {
              toolCall = {
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}'),
              }
              log.trace('[%s] 第%d轮 ★ 参数 JSON 解析成功', _fn, turn)
            } catch (parseErr) {
              log.error('[%s] 第%d轮 ★ 工具参数 JSON 解析失败: %s', _fn, turn, (parseErr as Error).message)
              log.debug('[%s] 第%d轮 ★ 原始参数: "%s"', _fn, turn, tc.function.arguments)
              throw parseErr
            }
            const toolResult = await agentService.execute(toolCall)
            toolTimer.stop()
            log.debug('[%s] 第%d轮 ★ 工具结果(%s): content=%s',
              _fn, turn, tcName, (toolResult?.content || '').slice(0, 200))
            chatContext.addToolResult(tc.id, toolResult.content)
            log.trace('[%s] 第%d轮 ★ 工具结果已加入 ChatContext', _fn, turn)
          }

          isUsingTools.value = false
          currentBubbleText.value = ""
          turnTimer.stop(`tools — continue`)
          log.info('[%s] 第%d轮 ★ 所有工具执行完毕，继续下一轮 AI 请求', _fn, turn)
          log.trace('[%s] 第%d轮 ◀ (continue to turn %d)', _fn, turn, turn + 1)
          // 继续循环，用工具结果再请求 AI
          continue
        }
      } catch (err) {
        const errMsg = (err as Error).message
        const errName = (err as Error).name
        if (errName === 'AbortError') {
          wasCancelled = true
          log.info('[%s] 第%d轮 ⏹ 请求被取消 (AbortError)', _fn, turn)
          break
        }
        log.error('[%s] 第%d轮 ✗ 错误: [%s] %s', _fn, turn, errName, errMsg)
        log.debug('[%s] 第%d轮 ✗ 错误堆栈: %s', _fn, turn, (err as Error).stack || '(无堆栈)')
        showBubbleText(t('app.bubble.error', { msg: errMsg }), false)
        break
      }
    }

    // ── 循环结束 ────────────────────────────────────────
    // 若本次请求已被取消/被新请求取代（abortController 已不是 myAbort），
    // 则跳过收尾，避免覆盖新请求的状态或弹出误导性兜底气泡。
    if (abortController !== myAbort) {
      log.info('[%s] ◀ 本次请求已被取消或被新请求取代，跳过收尾', _fn)
      _timer.stop()
      return
    }

    if (wasCancelled) {
      // 用户主动取消：不展示兜底气泡
      log.info('[%s] 已取消，跳过兜底提示', _fn)
    } else if (!currentBubbleText.value) {
      // 循环结束后没有文本回复（如全屏工具调用耗尽轮数），展示兜底提示
      log.info('[%s] ⚠ %d 轮循环后无文本回复，展示兜底提示 (finalTextFromLoop=%s)',
        _fn, toolTurns, finalTextFromLoop ? '有' : '无')
      showBubbleText(t('app.bubble.done'), false)
    } else {
      log.debug('[%s] 循环结束，气泡已设置 (%d字)', _fn, currentBubbleText.value.length)
    }

    isProcessing.value = false
    abortController = null
    log.debug('[%s] isProcessing → false abortController → null', _fn)
    _timer.stop()
    log.trace('[%s] ◀ (正常结束)', _fn)
  }

  /** 触发角色 TTS 语音播报 */
  let lastTtsText = ''
  async function triggerTts(text: string) {
    const _fn = 'triggerTts'
    log.trace('[%s] ▶ text="%s"', _fn, text?.slice(0, 50))

    // 去重：连续播报相同文本跳过
    if (text === lastTtsText) {
      log.trace('[%s] 跳过重复播报: text === lastTtsText', _fn)
      return
    }

    try {
      const charStore = useCharacterStore()
      const voiceId = charStore.data?.voice
      if (!voiceId) {
        log.trace('[%s] 无 voiceId 配置，跳过 TTS', _fn)
        return
      }
      const voiceLang = charStore.data?.voiceLanguage || '?'
      log.info('[%s] 开始 TTS 播报: voiceId=%s lang=%s text=%d字',
        _fn, voiceId, voiceLang, text.length)
      log.debug('[%s] TTS 文本: "%s"', _fn, text.slice(0, 120))
      const ttsTimer = debugTimer(_fn)
      await speakTextStreaming(text, voiceId)
      // 仅在成功播放后记下去重文本（失败/取消时不记录，允许重试）
      lastTtsText = text
      ttsTimer.stop()
      log.info('[%s] ✓ TTS 播报完成', _fn)
    } catch (err) {
      log.warn('[%s] ⚠ TTS 播报失败 (静默): %s', _fn, (err as Error).message)
    }
    log.trace('[%s] ◀', _fn)
  }

  function cancelResponse() {
    const _fn = 'cancelResponse'
    log.trace('[%s] ▶', _fn)
    log.debug('[%s] 取消前状态: isProcessing=%s isUsingTools=%s abortController=%s',
      _fn, isProcessing.value, isUsingTools.value, abortController ? '存在' : 'null')

    if (abortController) {
      log.trace('[%s] 调用 abortController.abort()', _fn)
      abortController.abort()
      abortController = null
      log.trace('[%s] abortController → null', _fn)
    } else {
      log.trace('[%s] abortController 已为 null', _fn)
    }

    isProcessing.value = false
    isUsingTools.value = false
    cancelSpeak()
    // 取消后重置 TTS 去重，以便重试时能再次播报被取消的同一段文本
    lastTtsText = ''
    // 隐藏正在生成的气泡与思考过程，避免残留半截内容
    hideBubble()
    currentThinking.value = ''
    log.info('[%s] ✓ AI 回复已取消 (isProcessing=%s isUsingTools=%s)',
      _fn, isProcessing.value, isUsingTools.value)
    log.trace('[%s] ◀', _fn)
  }

  function addMessage(role: ChatMessage['role'], text: string, thinking?: string) {
    const _fn = 'addMessage'
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const msgLen = text.length
    const thinkLen = thinking?.length || 0

    log.trace('[%s] ▶ role=%s text=%d字 thinking=%d字', _fn, role, msgLen, thinkLen)
    log.debug('[%s] 消息ID=%s role=%s text="%s"', _fn, id, role, text.slice(0, 60))

    messages.value.push({
      id,
      role,
      text,
      thinking: thinking || undefined,
      timestamp: Date.now(),
    })

    log.debug('[%s] ✓ 已添加: 当前消息总数=%d 最新ID=%s', _fn, messages.value.length, id)

    // 保存到当前会话
    const saveTimer = debugTimer(`${_fn} saveSession`)
    useSessionStore().saveCurrentSession()
    saveTimer.stop()
    log.trace('[%s] ◀', _fn)
  }

  function clearMessages() {
    const _fn = 'clearMessages'
    const prevCount = messages.value.length
    log.trace('[%s] ▶ (当前消息数=%d)', _fn, prevCount)

    // 先取消正在进行中的 AI 请求，避免其回调写入已被清空的上下文
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    isProcessing.value = false
    isUsingTools.value = false
    hideBubble()
    currentThinking.value = ''

    if (prevCount > 0) {
      log.debug('[%s] 最后一条消息: role=%s text="%s"', _fn,
        messages.value[prevCount - 1]?.role || '?',
        (messages.value[prevCount - 1]?.text || '').slice(0, 50))
    }

    messages.value = []
    log.trace('[%s] messages → []', _fn)

    chatContext = createChatContext()
    log.trace('[%s] chatContext → createChatContext()', _fn)

    // 保存清空状态到当前会话
    useSessionStore().saveCurrentSession()
    log.info('[%s] ✓ 已清空 %d 条聊天记录', _fn, prevCount)
    log.trace('[%s] ◀', _fn)
  }

  function resetContext() {
    const _fn = 'resetContext'
    log.trace('[%s] ▶', _fn)
    const oldContext = chatContext
    chatContext = createChatContext()
    log.debug('[%s] ✓ 对话上下文已重置 (old context=%s)', _fn, oldContext.constructor.name)
    log.trace('[%s] ◀', _fn)
  }

  /**
   * 加载历史消息（会话切换时使用）
   * 保留 system prompt，清除当前消息并用历史消息重建 AI 上下文
   */
  function loadMessages(msgs: ChatMessage[]) {
    const _fn = 'loadMessages'
    log.trace('[%s] ▶ msgs.length=%d', _fn, msgs.length)

    // 统计消息组成
    const userCount = msgs.filter(m => m.role === 'user').length
    const asstCount = msgs.filter(m => m.role === 'assistant').length
    log.debug('[%s] 消息组成: user=%d assistant=%d 总计=%d', _fn, userCount, asstCount, msgs.length)

    if (msgs.length > 0) {
      log.debug('[%s] 首条消息: role=%s text="%s"', _fn, msgs[0].role, msgs[0].text.slice(0, 50))
      log.debug('[%s] 末条消息: role=%s text="%s"', _fn, msgs[msgs.length - 1].role, msgs[msgs.length - 1].text.slice(0, 50))
    }

    messages.value = [...msgs]
    log.trace('[%s] messages 已替换（当前 %d 条）', _fn, messages.value.length)

    // 重置气泡和 AI 上下文
    hideBubble()
    showInput.value = false
    currentThinking.value = ''
    isProcessing.value = false
    isUsingTools.value = false
    log.trace('[%s] 气泡状态已重置: hideBubble showInput=false thinking=""', _fn)

    if (abortController) {
      log.trace('[%s] 取消进行中的请求 (abortController.abort())', _fn)
      abortController.abort()
      abortController = null
    }
    chatContext.reset()
    log.trace('[%s] ChatContext 已重置', _fn)

    // 重放消息到 AI 上下文（仅 user/assistant，工具调用已过期）
    log.trace('[%s] 开始重放 %d 条消息到 ChatContext...', _fn, msgs.length)
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      if (msg.role === 'user') {
        chatContext.addUserMessage(msg.text)
        log.trace('[%s]   [%d/%d] user → context: "%s"', _fn, i + 1, msgs.length, msg.text.slice(0, 40))
      } else if (msg.role === 'assistant') {
        chatContext.addAssistantMessage(msg.text)
        log.trace('[%s]   [%d/%d] assistant → context: "%s"', _fn, i + 1, msgs.length, msg.text.slice(0, 40))
      }
    }
    log.debug('[%s] ✓ 消息重放完成', _fn)

    // 会话切换后，气泡显示目标会话的最后一条 AI 消息（含思考过程）
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
    if (lastAssistant) {
      currentThinking.value = lastAssistant.thinking || ''
      showBubbleText(lastAssistant.text, false)
      log.debug('[%s] ✓ 显示最后AI消息: text="%s" thinking=%s',
        _fn, lastAssistant.text.slice(0, 40), lastAssistant.thinking ? `${lastAssistant.thinking.length}字` : '无')
    } else {
      log.trace('[%s] 无历史 AI 消息，气泡保持隐藏', _fn)
    }
    log.info('[%s] ✓ 已加载会话消息: %d 条 (user=%d asst=%d), 最后AI消息: %s',
      _fn, msgs.length, userCount, asstCount,
      lastAssistant ? `"${lastAssistant.text.slice(0, 30)}..."` : '无')
    log.trace('[%s] ◀', _fn)
  }

  /** 更新角色 system prompt（含语言配置） */
  function setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string) {
    const _fn = 'setSystemPrompt'
    log.trace('[%s] ▶ prompt=%d字 voiceLang=%s displayLang=%s',
      _fn, prompt?.length || 0, voiceLang || '?', displayLang || '?')
    log.debug('[%s] prompt前50字: "%s"', _fn, (prompt || '').slice(0, 50))
    chatContext.setSystemPrompt(prompt, voiceLang, displayLang)
    log.debug('[%s] ✓ system prompt 已更新', _fn)
    log.trace('[%s] ◀', _fn)
  }

  function showBubbleText(text: string, typing: boolean = true) {
    const _fn = 'showBubbleText'
    log.trace('[%s] text=%d字 typing=%s text="%s"', _fn, text.length, typing, text.slice(0, 50))
    currentBubbleText.value = text
    isTyping.value = typing
    showBubble.value = true
    log.debug('[%s] ✓ showBubble=%s isTyping=%s', _fn, showBubble.value, isTyping.value)
  }

  function hideBubble() {
    const _fn = 'hideBubble'
    log.trace('[%s] ▶ (当前文本=%d字)', _fn, currentBubbleText.value.length)
    currentBubbleText.value = ""
    isTyping.value = false
    showBubble.value = false
    log.trace('[%s] ◀ 气泡已隐藏', _fn)
  }

  function toggleInput() {
    showInput.value = !showInput.value
    log.trace('[toggleInput] showInput → %s', showInput.value)
  }

  function openInput() {
    showInput.value = true
    log.trace('[openInput] showInput → true')
  }

  function closeInput() {
    showInput.value = false
    log.trace('[closeInput] showInput → false')
  }

  return {
    messages,
    isProcessing,
    currentBubbleText,
    currentThinking,
    isTyping,
    showBubble,
    showInput,
    configReady,
    isUsingTools,
    init,
    sendMessage,
    cancelResponse,
    addMessage,
    clearMessages,
    resetContext,
    loadMessages,
    setSystemPrompt,
    showBubbleText,
    hideBubble,
    toggleInput,
    openInput,
    closeInput,
  }
})
