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
import { chat, isConfigValid, loadConfig, ChatContext, getToolTurns, translateText } from '../ai'
import type { ToolCallData } from '../ai'
import { agentService } from '../agent/service'
import { SAY_TOOL_NAME, SAY_TOOL_DEF } from '../agent'
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
  /** 角色母语台词（say 的 voice），用于会话恢复时忠实重建 say 工具调用 */
  voice?: string
  timestamp: number
}

/** 一次 chat() 调用的结果 */
type ChatResult =
  | { type: 'done'; text: string }
  | { type: 'tools'; calls: ToolCallData[]; text?: string }

/** 翻译函数签名（便于注入测试桩） */
type TranslateFn = (text: string, targetLang: string) => Promise<string>

/**
 * 从一组工具调用中分出 say（说话）与动作调用。
 * 多余的 say 仅取第一个，其余忽略。
 *
 * @internal 导出以支持单元测试
 */
export function splitSayCalls(calls: ToolCallData[]): {
  sayCall: ToolCallData | null
  actionCalls: ToolCallData[]
} {
  let sayCall: ToolCallData | null = null
  const actionCalls: ToolCallData[] = []
  for (const c of calls) {
    if (c.function?.name === SAY_TOOL_NAME) {
      if (!sayCall) sayCall = c
    } else {
      actionCalls.push(c)
    }
  }
  return { sayCall, actionCalls }
}

/**
 * 解析 say 工具参数（容错：非法 JSON 返回空对象）。
 *
 * @internal 导出以支持单元测试
 */
export function parseSayArgs(argStr: string): { voice?: string; display?: string } {
  try {
    const o = JSON.parse(argStr || '{}')
    if (o && typeof o === 'object') {
      return {
        voice: typeof o.voice === 'string' ? o.voice.trim() : undefined,
        display: typeof o.display === 'string' ? o.display.trim() : undefined,
      }
    }
  } catch { /* 非法 JSON */ }
  return {}
}

/**
 * say 内容字段级兜底：缺失的语言版本由系统翻译补出。
 * - 语言相同：voice/display 互为兜底，不调翻译
 * - 语言不同：缺谁补谁
 *
 * @internal 导出以支持单元测试（translate 可注入桩）
 */
export async function resolveSayContent(
  raw: { voice?: string; display?: string },
  voiceLang: string,
  displayLang: string,
  translate: TranslateFn,
): Promise<{ voice: string; display: string }> {
  let voice = raw.voice ?? ''
  let display = raw.display ?? ''
  if (voiceLang === displayLang) {
    if (!display) display = voice
    if (!voice) voice = display
    return { voice, display }
  }
  if (!display && voice) display = await translate(voice, displayLang)
  if (!voice && display) voice = await translate(display, voiceLang)
  return { voice, display }
}

/**
 * 模型未调用 say、直接输出正文时的兜底：
 * 正文当显示文本；语言不同时翻译出母语供 TTS（假设正文为显示语言，见设计文档）。
 *
 * @internal 导出以支持单元测试（translate 可注入桩）
 */
export async function resolveContentFallback(
  content: string,
  voiceLang: string,
  displayLang: string,
  translate: TranslateFn,
): Promise<{ voice: string; display: string }> {
  const display = (content ?? '').trim()
  if (!display) return { voice: '', display: '' }
  if (voiceLang === displayLang) return { voice: display, display }
  const voice = await translate(display, voiceLang)
  return { voice, display }
}

/** 包装 chat() 为 Promise 返回 */
function chatOnce(
  messages: ReturnType<ChatContext['getMessages']>,
  tools: any[],
  signal: AbortSignal,
  callbacks: { onThinking: (t: string) => void; onChunk: (t: string) => void },
): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    chat(
      messages,
      {
        onChunk: callbacks.onChunk,
        onThinking: callbacks.onThinking,
        onTools: (calls, textWithTools) => {
          resolve({ type: 'tools', calls, text: textWithTools })
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

    // ── 收集工具定义（含 say 说话工具）────────────────────
    const tools = [...agentService.getToolDefinitions(), SAY_TOOL_DEF]
    log.debug('[%s] 工具定义数量: %d (含 say)', _fn, tools.length)
    {
      const toolNames = tools.map(t => t.function?.name || '(unnamed)').join(', ')
      log.debug('[%s] 工具列表: [%s]', _fn, toolNames)
    }

    const config = loadConfig()
    /** 取当前角色的语言配置（角色可能在循环中被 switch_character 切换，故每次现取） */
    const getLangs = () => {
      const d = useCharacterStore().data
      return {
        voiceLang: d?.voiceLanguage || DEFAULT_VOICE_LANGUAGE,
        displayLang: resolveDisplayLanguage(d?.textLanguage),
        persona: d?.name,
      }
    }

    // 本次请求独享的 AbortController。后续始终引用 myAbort（而非可能被新请求/取消
    // 改写的模块级 abortController），避免并发请求互相干扰。
    const myAbort = new AbortController()
    abortController = myAbort
    let thinkSplitDone = false
    let finalTextFromLoop: string | null = null  // 追踪循环是否产生最终文本
    let wasCancelled = false                      // 用户主动取消标记（跳过兜底气泡）

    // ── 工具调用循环 ─────────────────────────────────────
    // 角色通过 say 工具说话；say 出现即视为最终回复并终止循环。
    // 仅有动作工具（无 say）则继续下一轮，让模型在动作后把话说出来。
    // 工具每轮都提供（说话本身就是工具调用）。循环上限按模型层级动态决定。
    const toolTurns = getToolTurns(config.model)

    /** 把最终台词落地：写气泡、入 UI 历史、触发 TTS */
    const deliver = (voice: string, display: string) => {
      currentBubbleText.value = display
      isTyping.value = true
      addMessage('assistant', display, currentThinking.value, voice)
      triggerTts(voice)
    }

    /**
     * 把一段台词作为合成的 say 工具调用写入 AI 上下文。
     * 用于兜底路径（模型没调 say）：使实时上下文与会话恢复重建的范式保持一致——
     * 助手回合始终表现为 say 调用，避免“纯文本回合”污染范式、诱导模型后续不再调工具。
     */
    const commitSyntheticSay = (voice: string, display: string) => {
      const sayId = `say_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      chatContext.addAssistantToolCall([{
        id: sayId,
        type: 'function',
        function: { name: SAY_TOOL_NAME, arguments: JSON.stringify({ voice, display }) },
      }])
      chatContext.addToolResult(sayId, '已说出')
    }

    log.trace('[%s] 工具循环开始 toolTurns=%d (model=%s)', _fn, toolTurns, config.model)
    for (let turn = 0; turn < toolTurns; turn++) {
      log.trace('[%s] ——— 第 %d/%d 轮 ———', _fn, turn + 1, toolTurns)
      const turnTimer = debugTimer(`${_fn} turn#${turn}`)

      try {
        let contentBuffer = ""  // 单轮缓冲区：仅用于实时提取 <think> 思考内容
        const chatTimer = debugTimer(`${_fn} chatOnce turn#${turn}`)
        log.trace('[%s] 第%d轮 chat() 发起请求...', _fn, turn)

        // 流式回调：实时提取 <think> 思考内容
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

        const result = await chatOnce(
          chatContext.getMessages(),
          tools,
          myAbort.signal,
          streamCallbacks,
        )
        chatTimer.stop()

        // ── 模型走了纯文本通道（没用 say = 兜底路径）────────
        if (result.type === 'done') {
          const finalText = result.text
          finalTextFromLoop = finalText
          log.info('[%s] 第%d轮 AI 纯文本回复(未走 say), 长度=%d', _fn, turn, finalText?.length || 0)
          log.debug('[%s] AI 回复前200字: "%s"', _fn, (finalText || '').slice(0, 200))

          // 兜底：不支持原生 FC 的模型可能把动作调用写在文字里
          const textCalls = agentService.extractTextToolCalls(finalText)
          if (textCalls.length > 0) {
            log.info('[%s] 第%d轮 ✦ 文本动作调用: %d 个', _fn, turn, textCalls.length)
            isUsingTools.value = true
            currentBubbleText.value = ""
            const cleanText = agentService.stripTextToolCalls(finalText)
            if (cleanText) chatContext.addAssistantMessage(cleanText)
            for (let ti = 0; ti < textCalls.length; ti++) {
              const tc = textCalls[ti]
              log.info('[%s] 第%d轮 ✦ 执行文本动作[%d/%d]: %s', _fn, turn, ti + 1, textCalls.length, tc.name || '?')
              const toolResult = await agentService.execute(tc)
              chatContext.addToolResult(tc.id, toolResult.content)
            }
            isUsingTools.value = false
            turnTimer.stop('text-tools — continue')
            continue
          }

          // 纯正文兜底：正文当显示文本，必要时翻译出母语供 TTS
          if (finalText && finalText.trim()) {
            const { voiceLang, displayLang, persona } = getLangs()
            const translate: TranslateFn = (txt, target) =>
              translateText(txt, target, { persona, signal: myAbort.signal })
            const { voice, display } = await resolveContentFallback(finalText, voiceLang, displayLang, translate)
            commitSyntheticSay(voice, display)
            deliver(voice, display)
            log.info('[%s] 第%d轮 ✓ 纯正文兜底完成 (显示:%d字, TTS:%d字)', _fn, turn, display.length, voice.length)
          } else {
            log.warn('[%s] 第%d轮 ⚠ AI 返回空文本', _fn, turn)
          }
          turnTimer.stop('done — break')
          break
        }

        // ── 模型走了工具通道（say 和/或动作工具）──────────
        if (result.type === 'tools') {
          const { sayCall, actionCalls } = splitSayCalls(result.calls)
          log.info('[%s] 第%d轮 ★ 工具调用: %d 个 (say=%s, 动作=%d)',
            _fn, turn, result.calls.length, sayCall ? '有' : '无', actionCalls.length)

          isUsingTools.value = actionCalls.length > 0
          currentBubbleText.value = ""

          // 整条 assistant tool_calls 消息入上下文（含 say，保证调用 id 与回执对应）
          chatContext.addAssistantToolCall(result.calls)

          // 先执行动作工具（让立绘先变）
          for (let ti = 0; ti < actionCalls.length; ti++) {
            const tc = actionCalls[ti]
            const toolTimer = debugTimer(`${_fn} tool#${ti} turn#${turn}`)
            const tcName = tc.function?.name || '?'
            log.info('[%s] 第%d轮 ★ 执行动作[%d/%d]: %s (id=%s)',
              _fn, turn, ti + 1, actionCalls.length, tcName, tc.id)
            log.debug('[%s] 第%d轮 ★ 参数: %s', _fn, turn, (tc.function?.arguments || '{}').slice(0, 300))
            let toolCall: ToolCall
            try {
              toolCall = {
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}'),
              }
            } catch (parseErr) {
              log.error('[%s] 第%d轮 ★ 工具参数 JSON 解析失败: %s', _fn, turn, (parseErr as Error).message)
              chatContext.addToolResult(tc.id, '参数解析失败')
              continue
            }
            const toolResult = await agentService.execute(toolCall)
            toolTimer.stop()
            log.debug('[%s] 第%d轮 ★ 工具结果(%s): %s', _fn, turn, tcName,
              (toolResult?.content || '').slice(0, 200))
            chatContext.addToolResult(tc.id, toolResult.content)
          }
          isUsingTools.value = false

          // ── say 出现 → 字段兜底 + 渲染 + TTS + 终止 ──────
          if (sayCall) {
            const { voiceLang, displayLang, persona } = getLangs()
            const translate: TranslateFn = (txt, target) =>
              translateText(txt, target, { persona, signal: myAbort.signal })
            const raw = parseSayArgs(sayCall.function?.arguments || '{}')
            log.info('[%s] 第%d轮 ✦ say 原始: voice=%d字 display=%d字',
              _fn, turn, raw.voice?.length || 0, raw.display?.length || 0)
            const { voice, display } = await resolveSayContent(raw, voiceLang, displayLang, translate)
            chatContext.addToolResult(sayCall.id, '已说出')  // 保持上下文合法
            finalTextFromLoop = display
            if (voice || display) {
              deliver(voice, display)
              log.info('[%s] 第%d轮 ✓ say 完成 (显示:%d字, TTS:%d字)', _fn, turn, display.length, voice.length)
            } else {
              log.warn('[%s] 第%d轮 ⚠ say 内容为空', _fn, turn)
            }
            turnTimer.stop('say — break')
            break
          }

          // ── 仅动作、无 say ──────────────────────────────
          // 模型把话写在正文里却忘了调 say → 用正文兜底；否则继续下一轮让它说
          if (result.text && result.text.trim()) {
            const { voiceLang, displayLang, persona } = getLangs()
            const translate: TranslateFn = (txt, target) =>
              translateText(txt, target, { persona, signal: myAbort.signal })
            log.warn('[%s] 第%d轮 ⚠ 有动作但未调 say，用正文兜底', _fn, turn)
            const { voice, display } = await resolveContentFallback(result.text, voiceLang, displayLang, translate)
            commitSyntheticSay(voice, display)
            finalTextFromLoop = display
            deliver(voice, display)
            turnTimer.stop('actions+content — break')
            break
          }
          turnTimer.stop('actions — continue')
          log.info('[%s] 第%d轮 ★ 仅动作无 say，继续下一轮', _fn, turn)
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

  function addMessage(role: ChatMessage['role'], text: string, thinking?: string, voice?: string) {
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
      voice: voice || undefined,
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

    // 重放消息到 AI 上下文。
    // 关键：助手回合必须重建为 say 工具调用（而非纯文本）。否则恢复出的历史会呈现
    // “助手只用纯文本回复、从不调用工具”的范式，模型会模仿它而忘记调用 say/动作工具
    // （会话切走再切回后表现为“忘记使用工具”）。
    log.trace('[%s] 开始重放 %d 条消息到 ChatContext...', _fn, msgs.length)
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      if (msg.role === 'user') {
        chatContext.addUserMessage(msg.text)
        log.trace('[%s]   [%d/%d] user → context: "%s"', _fn, i + 1, msgs.length, msg.text.slice(0, 40))
      } else if (msg.role === 'assistant') {
        // 重建为 say 调用：voice 取持久化的母语台词（旧会话缺失则回退显示文本）
        const sayId = `say_replay_${i}`
        chatContext.addAssistantToolCall([{
          id: sayId,
          type: 'function',
          function: {
            name: SAY_TOOL_NAME,
            arguments: JSON.stringify({ voice: msg.voice || msg.text, display: msg.text }),
          },
        }])
        chatContext.addToolResult(sayId, '已说出')
        log.trace('[%s]   [%d/%d] assistant → say 调用重建: "%s"', _fn, i + 1, msgs.length, msg.text.slice(0, 40))
      }
    }
    log.debug('[%s] ✓ 消息重放完成（助手回合已重建为 say 调用）', _fn)

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
