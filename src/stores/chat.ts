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
import {
  chat, isConfigValid, loadConfig, ChatContext, MAX_TOOL_TURNS, translateText,
  MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES,
} from '../ai'
import type {
  ChatContextInspection,
  ChatContextSnapshot,
  ChatInputPayload,
  ContextStats,
  ImageAttachment,
  ToolCallData,
} from '../ai'
import { agentService } from '../agent/service'
import { SAY_TOOL_NAME, SAY_TOOL_DEF } from '../agent'
import type { ToolCall, ToolDefinition, ToolResult } from '../agent'
import {
  isMutatingTool,
  mutatingPath,
  getAutoExecFiles,
  shouldConfirm,
  isDangerousTool,
  dangerousToolSummary,
  getScreenCaptureEnabled,
  isScreenCaptureTool,
} from '../agent/toolPolicy'
import { prepareCommandExecution, approveCommandExecution } from '../agent/tools/command'
import type { ExecutionPlan } from '../agent/tools/command'
import { speakTextStreaming, cancelSpeak, getTtsProvider } from '../tts'
import type { TtsPlaybackStatus } from '../tts'
import { useCharacterStore } from '../character'
import { createLogger } from '../utils/logger'
import { t } from '../i18n'
import { useSessionStore } from './session'
import { DEFAULT_VOICE_LANGUAGE } from '../constants'
import { resolveDisplayLanguage } from './language'

const log = createLogger('ChatStore')

/**
 * 收集单轮工具输出图片并执行请求级数量/体积限制。
 * 返回值表示是否有图片因超限被丢弃，调用方可把提示写进工具文本回执。
 */
function collectToolImages(result: ToolResult, collected: ImageAttachment[]): boolean {
  let rejected = false
  let totalBytes = collected.reduce((sum, image) => sum + image.size, 0)
  for (const image of result.images ?? []) {
    if (collected.length >= MAX_IMAGE_COUNT || totalBytes + image.size > MAX_TOTAL_IMAGE_BYTES) {
      rejected = true
      continue
    }
    collected.push(image)
    totalBytes += image.size
  }
  return rejected
}

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
      log.trace("chat_store.debug_timer.trace", `[⏱Timer] ${label}${tag}: ${elapsed}ms`, { label: label, tag: tag, elapsed: elapsed })
      return elapsed
    },
    lap: (tag: string) => {
      const elapsed = Math.round(performance.now() - start)
      log.trace("chat_store.debug_timer.trace", `[⏱Lap] ${label} — ${tag}: ${elapsed}ms`, { label: label, tag: tag, elapsed: elapsed })
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
  /** 用户本轮发送的图片；仅用户消息使用。 */
  images?: ImageAttachment[]
  timestamp: number
  /** 消息发出时的角色身份快照（assistant 消息）；旧数据缺失时由界面回退当前角色名 */
  charId?: string
  charName?: string
}

/** 当前会话完整上下文的只读检查结果，仅用于设置页手动快照。 */
export interface CurrentContextInspection extends ChatContextInspection {
  capturedAt: number
  model: string
  endpoint: string
  toolDefinitions: ToolDefinition[]
  persona: {
    voiceLang: string
    displayLang: string
    render: 'illustration' | 'live2d'
  } | null
  runtime: {
    processing: boolean
    usingTools: boolean
    activities: ToolActivity[]
    pendingConfirmation: { toolName: string; path: string } | null
    autoExecSession: boolean
  }
}

/** 角色身份来源：由 App 注入（避免 store 直接依赖 Pinia 角色状态） */
let characterIdentity: (() => { id: string; name: string } | null) | null = null

/** 注入角色身份读取函数，assistant 消息落库时记录身份快照 */
export function setChatCharacterIdentity(getter: () => { id: string; name: string } | null): void {
  characterIdentity = getter
}

/** 工具调用活动（主窗口右侧列表用，临时态，不持久化） */
export interface ToolActivity {
  /** 工具调用 id（动作工具用 tc.id，文本兜底用其生成 id） */
  id: string
  /** 原始工具名，如 'read_file'、'set_character_emotion' */
  name: string
  /** 执行状态 */
  status: 'running' | 'done' | 'error' | 'skipped'
}

/** 待确认的文件操作（非空即弹确认卡） */
export interface PendingConfirm {
  /** 工具调用 id */
  id: string
  /** 工具名，如 'write_file' */
  toolName: string
  /** 受影响的相对路径 */
  path: string
  /** 原始参数（确认卡据此计算 diff 与摘要） */
  args: Record<string, any>
  /** 高风险任务由 Rust 规范化后的不可变计划；普通文件确认无此字段。 */
  executionPlan?: ExecutionPlan
}

/** 待确认的屏幕截图；每次只能允许一次或拒绝。 */
export interface PendingScreenCaptureConfirm {
  id: string
  toolName: string
  target: 'cursor_monitor' | 'primary_monitor'
  includeKisaki: boolean
}

/** 文件操作确认决定 */
export type ConfirmDecision = 'allow' | 'allow-session' | 'reject'

/** 一次 chat() 调用的结果 */
type ChatResult =
  | { type: 'done'; text: string }
  | { type: 'tools'; calls: ToolCallData[]; text?: string }

/** 翻译函数签名（便于注入测试桩） */
type TranslateFn = (
  text: string,
  targetLang: string,
  opts?: { ttsSafe?: boolean },
) => Promise<string>

/** voice 只允许 Unicode 文字、组合附加符、普通空格和半角逗号。 */
function isTtsSafeVoice(text: string): boolean {
  return /^[\p{L}\p{M} ,]*$/u.test(text)
}

/**
 * 修复模型在日语单词内误插的半角逗号。
 *
 * 例如 `こ,れから` 应为 `これから`；而 `はい,わかりました` 仍保留分句逗号。
 * Intl.Segmenter 不可用时安全回退为不修改。
 */
function repairJapaneseWordCommas(text: string, voiceLang: string): string {
  if (!/^ja(?:-|$)/i.test(voiceLang) || !text.includes(',')) return text
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: 'word' }) => {
      segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
    }
  }).Segmenter
  if (!Segmenter) return text

  const segmenter = new Segmenter('ja', { granularity: 'word' })
  return text.replace(
    /[\p{Script=Hiragana}\p{Script=Katakana}]+(?:,[\p{Script=Hiragana}\p{Script=Katakana}]+)+/gu,
    (run) => {
      const parts = run.split(',')
      const joined = parts.join('')
      const wordBoundaries = new Set<number>()
      let segmentedLength = 0
      for (const part of segmenter.segment(joined)) {
        segmentedLength += part.segment.length
        if (part.isWordLike && segmentedLength < joined.length) wordBoundaries.add(segmentedLength)
      }

      let result = parts[0]
      let sourceOffset = parts[0].length
      for (const next of parts.slice(1)) {
        // 逗号正好落在分词边界时是分句；落在词内时是模型误插。
        result += wordBoundaries.has(sourceOffset) ? `,${next}` : next
        sourceOffset += next.length
      }
      return result
    },
  )
}

/**
 * 对不需要语义理解的 voice 问题做本地、确定性修复。
 *
 * 只接受文字、空白、半角逗号和常见中日句读符号。数字、网址、代码或其他符号
 * 仍返回 null，交给翻译模型按语义改写，避免简单删符号造成误读。
 *
 * @internal 导出以支持单元测试
 */
export function normalizeTtsSafeVoice(text: string, voiceLang: string): string | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return ''
  if (!/^[\p{L}\p{M}\s,、，。！？；：]*$/u.test(trimmed)) return null

  let normalized = trimmed
    .replace(/[、，。！？；：]+/gu, ',')
    .replace(/\s+/gu, ' ')
    .replace(/\s*,\s*/gu, ',')
    .replace(/,+/gu, ',')
    .replace(/^,+|,+$/gu, '')
  normalized = repairJapaneseWordCommas(normalized, voiceLang)
  return normalized && isTtsSafeVoice(normalized) ? normalized : null
}

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
 * - voice 只有句读问题时本地修复；缺失或需要语义改写时才调用翻译兜底
 * - display 缺失且语言不同时，翻译 voice 补出
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
  const normalizedVoice = voice ? normalizeTtsSafeVoice(voice, voiceLang) : null
  if (normalizedVoice !== null) voice = normalizedVoice
  if (voiceLang === displayLang) {
    if (!display) display = voice
    if (!voice && display) voice = await translate(display, voiceLang, { ttsSafe: true })
    else if (voice && normalizedVoice === null) voice = await translate(voice, voiceLang, { ttsSafe: true })
    return { voice, display }
  }
  if (!display && voice) display = await translate(voice, displayLang)
  if (!voice && display) voice = await translate(display, voiceLang, { ttsSafe: true })
  else if (voice && normalizedVoice === null) voice = await translate(voice, voiceLang, { ttsSafe: true })
  return { voice, display }
}

/**
 * 模型未调用 say、直接输出正文时的兜底：
 * 正文当显示文本；无论语言是否相同，都生成一份 TTS 安全的母语台词。
 *
 * @internal 导出以支持单元测试（translate 可注入桩）
 */
export async function resolveContentFallback(
  content: string,
  voiceLang: string,
  _displayLang: string,
  translate: TranslateFn,
): Promise<{ voice: string; display: string }> {
  const display = (content ?? '').trim()
  if (!display) return { voice: '', display: '' }
  const voice = await translate(display, voiceLang, { ttsSafe: true })
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
  const contextStats = ref<ContextStats>({
    estimatedTokens: 0,
    maxContextTokens: 0,
    toolDefinitionTokens: 0,
    messageCount: 0,
    summarizedRounds: 0,
    prunedMessages: 0,
    utilization: 0,
  })
  /** 当前是否正在执行工具（子状态） */
  const isUsingTools = ref(false)

  // ── 工具调用过程展示（主窗口右侧列表，仅处理时临时展示，不持久化） ──
  /** 单条工具调用活动 */
  const toolActivities = ref<ToolActivity[]>([])
  /** 是否显示工具活动列表（处理时点亮，完成后延时淡出） */
  const showToolActivity = ref(false)

  // ── 文件修改确认（逐个确认；本会话自动允许；全局开关见 toolPolicy） ──
  /** 待确认的文件操作（非空即弹确认卡） */
  const pendingConfirm = ref<PendingConfirm | null>(null)
  /** 本会话内自动允许（运行时，不持久化；清空 / 切换会话时重置） */
  const autoExecSession = ref(false)
  /** 等待用户确认的 resolver */
  let confirmResolver: ((d: ConfirmDecision) => void) | null = null

  /** 确认卡无响应超时（5 分钟）：超时自动拒绝，避免用户离开后永久挂起阻塞 isProcessing */
  const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

  /** 设待确认项并等待用户决定（在确认卡按钮触发 resolveConfirm 后兑现） */
  function waitUserConfirm(tc: ToolCall, signal: AbortSignal): Promise<ConfirmDecision> {
    return new Promise((resolve) => {
      // 已取消：直接拒绝，避免无人应答而卡住循环
      if (signal.aborted) { resolve('reject'); return }

      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      function finish(d: ConfirmDecision) {
        if (settled) return
        settled = true
        if (timeoutId !== null) clearTimeout(timeoutId)
        signal.removeEventListener('abort', onAbort)
        confirmResolver = null
        pendingConfirm.value = null
        resolve(d)
      }
      function onAbort() { finish('reject') }

      timeoutId = setTimeout(() => {
        log.warn("chat_store.wait_user_confirm.warn", `文件操作确认超时（${CONFIRM_TIMEOUT_MS / 60000} 分钟），自动拒绝`, undefined, { confirm_timeout_ms: CONFIRM_TIMEOUT_MS / 60000 })
        finish('reject')
      }, CONFIRM_TIMEOUT_MS)

      pendingConfirm.value = {
        id: tc.id,
        toolName: tc.name,
        path: mutatingPath(tc.name, tc.arguments) || '',
        args: tc.arguments,
      }
      confirmResolver = (d) => finish(d)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** UI 调用：对当前待确认项作出决定 */
  function resolveConfirm(decision: ConfirmDecision) {
    confirmResolver?.(decision)
  }

  // ── 屏幕截图确认（每次都必须确认，无自动允许） ──
  const pendingScreenCaptureConfirm = ref<PendingScreenCaptureConfirm | null>(null)
  let screenCaptureConfirmResolver: ((d: 'allow' | 'reject') => void) | null = null

  function waitScreenCaptureConfirm(
    tc: ToolCall,
    signal: AbortSignal,
  ): Promise<'allow' | 'reject'> {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve('reject'); return }

      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      function finish(d: 'allow' | 'reject') {
        if (settled) return
        settled = true
        if (timeoutId !== null) clearTimeout(timeoutId)
        signal.removeEventListener('abort', onAbort)
        screenCaptureConfirmResolver = null
        pendingScreenCaptureConfirm.value = null
        resolve(d)
      }
      function onAbort() { finish('reject') }

      timeoutId = setTimeout(() => {
        log.warn("chat_store.wait_screen_capture_confirm.warn", `屏幕截图确认超时（${CONFIRM_TIMEOUT_MS / 60000} 分钟），自动拒绝`, undefined, { confirm_timeout_ms: CONFIRM_TIMEOUT_MS / 60000 })
        finish('reject')
      }, CONFIRM_TIMEOUT_MS)

      pendingScreenCaptureConfirm.value = {
        id: tc.id,
        toolName: tc.name,
        target: tc.arguments.target === 'primary_monitor' ? 'primary_monitor' : 'cursor_monitor',
        includeKisaki: tc.arguments.include_kisaki === true,
      }
      screenCaptureConfirmResolver = finish
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  function resolveScreenCaptureConfirm(decision: 'allow' | 'reject') {
    screenCaptureConfirmResolver?.(decision)
  }

  function rejectPendingScreenCaptureConfirm() {
    if (screenCaptureConfirmResolver) {
      const resolver = screenCaptureConfirmResolver
      screenCaptureConfirmResolver = null
      pendingScreenCaptureConfirm.value = null
      resolver('reject')
    }
  }

  // ── 命令执行确认（每次都必须确认，无自动允许） ──
  /** 待确认的命令执行（非空即弹 CommandConfirm 卡） */
  const pendingCommandConfirm = ref<PendingConfirm | null>(null)
  /** 等待用户确认命令的 resolver */
  let commandConfirmResolver: ((d: 'allow' | 'reject') => void) | null = null

  /** 设待确认项并等待用户决定 */
  function waitCommandConfirm(
    tc: ToolCall,
    signal: AbortSignal,
    executionPlan: ExecutionPlan,
  ): Promise<'allow' | 'reject'> {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve('reject'); return }

      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      function finish(d: 'allow' | 'reject') {
        if (settled) return
        settled = true
        if (timeoutId !== null) clearTimeout(timeoutId)
        signal.removeEventListener('abort', onAbort)
        commandConfirmResolver = null
        pendingCommandConfirm.value = null
        resolve(d)
      }
      function onAbort() { finish('reject') }

      timeoutId = setTimeout(() => {
        log.warn("chat_store.wait_command_confirm.warn", `命令执行确认超时（${CONFIRM_TIMEOUT_MS / 60000} 分钟），自动拒绝`, undefined, { confirm_timeout_ms: CONFIRM_TIMEOUT_MS / 60000 })
        finish('reject')
      }, CONFIRM_TIMEOUT_MS)

      pendingCommandConfirm.value = {
        id: tc.id,
        toolName: tc.name,
        path: dangerousToolSummary(tc.name, tc.arguments) || '',
        args: tc.arguments,
        executionPlan,
      }
      commandConfirmResolver = (d) => finish(d)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** UI 调用：对当前待确认的命令作出决定 */
  function resolveCommandConfirm(decision: 'allow' | 'reject') {
    commandConfirmResolver?.(decision)
  }

  /** 取消 / 清空时兜底拒绝待确认的命令 */
  function rejectPendingCommandConfirm() {
    if (commandConfirmResolver) {
      const r = commandConfirmResolver
      commandConfirmResolver = null
      pendingCommandConfirm.value = null
      r('reject')
    }
  }

  /** 取消 / 清空时兜底拒绝待确认项，避免工具循环卡死在 await */
  function rejectPendingConfirm() {
    if (confirmResolver) {
      const r = confirmResolver
      confirmResolver = null
      pendingConfirm.value = null
      r('reject')
    }
  }

  /** 新增一条「执行中」活动并点亮列表 */
  function beginActivity(id: string, name: string) {
    if (toolHideTimer !== null) { clearTimeout(toolHideTimer); toolHideTimer = null }
    toolActivities.value.push({ id, name, status: 'running' })
    showToolActivity.value = true
  }

  /** 把指定活动标记为完成 / 失败 / 跳过 */
  function endActivity(id: string, status: ToolActivity['status']) {
    const a = toolActivities.value.find(x => x.id === id)
    if (a) a.status = status
  }

  /** 优先使用结构化状态，兼容旧工具结果时再回退到文本判断。 */
  function isToolError(result: Pick<ToolResult, 'ok' | 'content'>): boolean {
    if (typeof result.ok === 'boolean') return !result.ok
    return /^(工具执行错误|工具执行失败|错误[:：])/.test(result.content || '')
  }

  /** 工具结果是否为「被用户拒绝」（executeWithPolicy 拒绝时的前缀） */
  function isToolSkipped(content: string): boolean {
    return /^用户已拒绝/.test(content || '')
  }

  /** 由工具结果内容推断活动状态 */
  function resultStatus(result: Pick<ToolResult, 'ok' | 'content'>): ToolActivity['status'] {
    if (isToolSkipped(result.content)) return 'skipped'
    if (isToolError(result)) return 'error'
    return 'done'
  }

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
  let currentPersona: {
    prompt: string
    voiceLang?: string
    displayLang?: string
    render?: 'illustration' | 'live2d'
  } | null = null

  function syncContextStats() {
    contextStats.value = chatContext.getStats()
  }

  syncContextStats()
  let abortController: AbortController | null = null
  /** 工具活动列表淡出延时器（处理结束后保留一会儿再隐藏） */
  let toolHideTimer: ReturnType<typeof setTimeout> | null = null

  function init() {
    log.trace("chat_store.init.trace", "[init] ▶")
    const timer = debugTimer('init')
    const cfg = loadConfig()
    const valid = isConfigValid(cfg)
    configReady.value = valid
    log.info("chat_store.init.info", `[init] ChatStore 初始化, 配置${valid ? '' : '未'}就绪`, { valid: valid ? '' : '未' })
    log.debug("chat_store.init.debug", `[init] 配置详情: model=${cfg.model || '(未设置)'} baseURL=${cfg.baseURL || '(默认)'} hasKey=${cfg.apiKey ? '✓' : '✗'}`, { cfg_model: cfg.model || '(未设置)', cfg_base_url: cfg.baseURL || '(默认)', cfg_api_key: cfg.apiKey ? '✓' : '✗' })
    log.trace("chat_store.init.trace", `[init] configReady → ${valid}`, { valid: valid })
    timer.stop()
    log.trace("chat_store.init.trace", "[init] ◀")
  }

  /** 发送消息给 AI（支持工具调用循环） */
  async function sendMessage(input: string | ChatInputPayload): Promise<boolean> {
    const _fn = 'sendMessage'
    let failed = false
    const _timer = debugTimer(_fn)
    const rawText = typeof input === 'string' ? input : input.text
    const images = typeof input === 'string' ? [] : input.images
    log.trace("chat_store.send_message.trace", `[${_fn}] ▶ text=${rawText?.length ?? 0} 字符, images=${images.length}`, { fn: _fn, raw_text_length: rawText?.length ?? 0, images_length: images.length })

    // ── 守卫条件检查 ────────────────────────────────────
    if (isProcessing.value) {
      log.warn("chat_store.send_message.warn", `[${_fn}] ⚠ 正在处理中，忽略重复请求 (text=${rawText?.length ?? 0} 字符)`, undefined, { fn: _fn, raw_text_length: rawText?.length ?? 0 })
      return false
    }
    if ((!rawText || !rawText.trim()) && images.length === 0) {
      log.warn("chat_store.send_message.warn", `[${_fn}] ⚠ 收到空消息，忽略`, undefined, { fn: _fn })
      return false
    }

    const userText = rawText.trim() || t('chat.input.imageOnlyPrompt')
    isProcessing.value = true
    log.debug("chat_store.send_message.debug", `[${_fn}] isProcessing → true`, { fn: _fn })

    // 重置工具活动列表（本次请求独立展示，等首个工具调用再点亮）
    if (toolHideTimer !== null) { clearTimeout(toolHideTimer); toolHideTimer = null }
    toolActivities.value = []
    showToolActivity.value = false

    // 用户发送新消息时，取消正在播放的语音
    log.trace("chat_store.send_message.trace", `[${_fn}] 取消正在播放的语音`, { fn: _fn })
    cancelSpeak()

    if (!navigator.onLine) {
      log.warn("chat_store.send_message.warn", `[${_fn}] ✗ 网络不可用，无法发送消息`, undefined, { fn: _fn })
      log.debug("chat_store.send_message.debug", `[${_fn}] navigator.onLine=${navigator.onLine}`, { fn: _fn, navigator_on_line: navigator.onLine })
      showBubbleText(t('app.bubble.networkOff'), false)
      isProcessing.value = false
      log.trace("chat_store.send_message.trace", `[${_fn}] ◀ (网络不可用)`, { fn: _fn })
      return false
    }

    const cfgCheck = loadConfig()
    if (!isConfigValid(cfgCheck)) {
      log.warn("chat_store.send_message.warn", `[${_fn}] ✗ API 未配置 (model=${cfgCheck.model || '?'} baseURL=${cfgCheck.baseURL || '?'} hasKey=${cfgCheck.apiKey ? '✓' : '✗'})`, undefined, { fn: _fn, cfg_check_model: cfgCheck.model || '?', cfg_check_base_url: cfgCheck.baseURL || '?', cfg_check_api_key: cfgCheck.apiKey ? '✓' : '✗' })
      showBubbleText(t('app.bubble.apiNotConfigured'), false)
      isProcessing.value = false
      log.trace("chat_store.send_message.trace", `[${_fn}] ◀ (配置无效)`, { fn: _fn })
      return false
    }

    const requestId = globalThis.crypto.randomUUID()
    const requestStartedAt = performance.now()
    let modelCallCount = 0
    let toolCallCount = 0
    let toolFailureCount = 0
    let turnsUsed = 0
    let fallbackUsed = false
    let ttsStatus: TtsPlaybackStatus | 'idle' = 'idle'
    log.info("chat.request_started", "对话请求开始", {
      requestId,
      textLength: rawText.length,
      imageCount: images.length,
      model: cfgCheck.model,
    })

    log.info("chat_store.send_message.info", `[${_fn}] 用户消息: ${userText.length} 字符${images.length ? ` + ${images.length} 图` : ''}`, { fn: _fn, user_text_length: userText.length, images_length: images.length })
    log.debug("chat_store.send_message.debug", `[${_fn}] 消息长度: ${userText.length} 字符, 图片: ${images.length} 张`, { fn: _fn, user_text_length: userText.length, images_length: images.length })

    // ── 添加用户消息 ────────────────────────────────────
    chatContext.addUserMessage(userText, images)
    syncContextStats()
    const userMsgId = addMessage('user', userText, undefined, undefined, images)
    log.trace("chat_store.send_message.trace", `[${_fn}] 用户消息已加入 ChatContext`, { fn: _fn })

    // 为本回合建立回档检查点（记录回合前的视觉状态；改文件工具执行时再按需备份文件）
    const checkpointId = useSessionStore().beginCheckpoint(userMsgId)

    // ── 准备气泡 ────────────────────────────────────────
    showBubble.value = true
    currentBubbleText.value = ""
    isTyping.value = false
    currentThinking.value = ''
    log.trace("chat_store.send_message.trace", `[${_fn}] 气泡状态: showBubble=true text="" isTyping=false`, { fn: _fn })

    // ── 同步角色数据到 agent 上下文 ─────────────────────
    {
      const charStore = useCharacterStore()
      if (charStore.data) {
        agentService.syncCharacterData(charStore.data)
        log.trace("chat_store.send_message.trace", `[${_fn}] 角色数据已同步到 agent 上下文 (voice=${charStore.data.voice || '?'} lang=${charStore.data.voiceLanguage || '?'})`, { fn: _fn, char_store_data: charStore.data.voice || '?', char_store_data2: charStore.data.voiceLanguage || '?' })
      } else {
        log.trace("chat_store.send_message.trace", `[${_fn}] 无角色数据可同步`, { fn: _fn })
      }
    }

    // ── 收集工具定义（含 say 说话工具）────────────────────
    const tools = [...agentService.getToolDefinitions(), SAY_TOOL_DEF]
    log.debug("chat_store.send_message.debug", `[${_fn}] 工具定义数量: ${tools.length} (含 say)`, { fn: _fn, tools_length: tools.length })
    {
      const toolNames = tools.map(t => t.function?.name || '(unnamed)').join(', ')
      log.debug("chat_store.send_message.debug", `[${_fn}] 工具列表: [${toolNames}]`, { fn: _fn, tool_names: toolNames })
    }

    const config = loadConfig()
    /** 取当前角色的语言配置（控制器可能在本轮初始化期间才完成挂载，故每次现取） */
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
    // 循环何时结束由模型自己决定：只要它持续调用工具（读写文件、切换情绪等）
    // 而不 say，循环就一直继续；MAX_TOOL_TURNS 仅为防失控的安全护栏。
    const toolTurns = MAX_TOOL_TURNS

    /** 把最终台词落地：写气泡、入 UI 历史、触发 TTS */
    const deliver = (voice: string, display: string) => {
      // 已取消：翻译兜底期间被用户中止时，不交付、不落盘、不播报
      if (myAbort.signal.aborted) return
      currentBubbleText.value = display
      isTyping.value = true
      addMessage('assistant', display, currentThinking.value, voice)
      // 触发 TTS 并回填真实状态到请求指标（气泡已立即可见，不阻塞）。
      triggerTts(voice).then(s => { if (s) ttsStatus = s })
    }

    /**
     * 把一段台词作为合成的 say 工具调用写入 AI 上下文。
     * 用于兜底路径（模型没调 say）：使实时上下文与会话恢复重建的范式保持一致——
     * 助手回合始终表现为 say 调用，避免“纯文本回合”污染范式、诱导模型后续不再调工具。
     */
    const commitSyntheticSay = (voice: string, display: string) => {
      // 已取消：不污染上下文
      if (myAbort.signal.aborted) return
      const sayId = `say_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      chatContext.addAssistantToolCall([{
        id: sayId,
        type: 'function',
        function: { name: SAY_TOOL_NAME, arguments: JSON.stringify({ voice, display }) },
      }])
      chatContext.addToolResult(sayId, '已说出')
      syncContextStats()
    }

    /**
     * 执行一个工具调用，并对「改文件」工具施加策略：
     *   1. 需确认则弹确认卡并等待用户决定（拒绝 → 不执行，回执告知模型）。
     *   2. 执行前对目标文件做写时复制备份（失败仅告警，不阻断）。
     * 非改文件工具直接执行。
     */
    const executeWithPolicy = async (tc: ToolCall): Promise<ToolResult> => {
      // 截图是高隐私读取：设置开关只负责暴露工具，实际每次仍需用户允许一次。
      if (isScreenCaptureTool(tc.name)) {
        if (!getScreenCaptureEnabled()) {
          return {
            role: 'tool',
            tool_call_id: tc.id,
            content: '屏幕截图权限当前未开启，未执行。请提示用户在「设置 → 权限」中开启后再重试。',
            ok: false,
            code: 'SCREEN_CAPTURE_DISABLED',
            retryable: true,
          }
        }
        const decision = await waitScreenCaptureConfirm(tc, myAbort.signal)
        if (decision === 'reject') {
          log.info("chat_store.execute_with_policy.info", `[${_fn}] ✗ 用户拒绝屏幕截图`, { fn: _fn })
          return { role: 'tool', tool_call_id: tc.id, content: '用户已拒绝屏幕截图，未执行。', ok: false, code: 'USER_REJECTED', retryable: false }
        }
        log.info("chat_store.execute_with_policy.info", `[${_fn}] ✓ 用户允许单次屏幕截图`, { fn: _fn })
      }
      // 高风险工具（如命令执行）→ 每次都必须确认，无自动允许
      if (isDangerousTool(tc.name)) {
        let executionPlan: ExecutionPlan
        try {
          executionPlan = await prepareCommandExecution(tc.name, tc.arguments)
        } catch (error) {
          return {
            role: 'tool',
            tool_call_id: tc.id,
            content: `任务准备失败: ${(error as Error)?.message || String(error)}`,
            ok: false,
            code: 'COMMAND_PREPARATION_FAILED',
            retryable: true,
          }
        }
        const decision = await waitCommandConfirm(tc, myAbort.signal, executionPlan)
        if (decision === 'reject') {
          log.info("chat_store.execute_with_policy.info", `[${_fn}] ✗ 用户拒绝高风险操作: ${tc.name}`, { fn: _fn, tc_name: tc.name })
          return { role: 'tool', tool_call_id: tc.id, content: '用户已拒绝该操作。', ok: false, code: 'USER_REJECTED', retryable: false }
        }
        log.info("chat_store.execute_with_policy.info", `[${_fn}] ✓ 用户允许高风险操作: ${tc.name}`, { fn: _fn, tc_name: tc.name })
        try {
          const approvalToken = await approveCommandExecution(executionPlan)
          return agentService.execute({
            ...tc,
            arguments: {
              ...tc.arguments,
              __plan_id: executionPlan.id,
              __approval_token: approvalToken,
              __display_command: executionPlan.display_command,
            },
          })
        } catch (error) {
          return {
            role: 'tool',
            tool_call_id: tc.id,
            content: `任务批准失败: ${(error as Error)?.message || String(error)}`,
            ok: false,
            code: 'COMMAND_APPROVAL_FAILED',
            retryable: true,
          }
        }
      }
      if (shouldConfirm(tc.name, { globalAuto: getAutoExecFiles(), sessionAuto: autoExecSession.value })) {
        const decision = await waitUserConfirm(tc, myAbort.signal)
        if (decision === 'reject') {
          log.info("chat_store.execute_with_policy.info", `[${_fn}] ✗ 用户拒绝文件操作: ${tc.name}`, { fn: _fn, tc_name: tc.name })
          return { role: 'tool', tool_call_id: tc.id, content: '用户已拒绝该文件操作，未执行。', ok: false, code: 'USER_REJECTED', retryable: false }
        }
        if (decision === 'allow-session') {
          autoExecSession.value = true
          log.info("chat_store.execute_with_policy.info", `[${_fn}] 用户选择「本会话自动允许」文件操作`, { fn: _fn })
        }
      }
      if (isMutatingTool(tc.name)) {
        const rel = mutatingPath(tc.name, tc.arguments)
        if (rel) {
          try {
            await useSessionStore().backupFile(checkpointId, rel)
            useSessionStore().markCheckpointFiles(checkpointId)
          } catch (e) {
            log.warn("chat_store.execute_with_policy.warn", `[${_fn}] ⚠ 文件备份失败（继续执行）: ${(e as Error).message}`, e, { fn: _fn })
          }
        }
      }
      return agentService.execute(tc)
    }

    log.trace("chat_store.send_message.trace", `[${_fn}] 工具循环开始 安全上限=${toolTurns} 轮 (model=${config.model})`, { fn: _fn, tool_turns: toolTurns, config_model: config.model })
    for (let turn = 0; turn < toolTurns; turn++) {
      turnsUsed = turn + 1
      log.trace("chat_store.send_message.trace", `[${_fn}] ——— 第 ${turn + 1}/${toolTurns} 轮 ———`, { fn: _fn, turn: turn + 1, tool_turns: toolTurns })
      const turnTimer = debugTimer(`${_fn} turn#${turn}`)

      try {
        let contentBuffer = ""  // 单轮缓冲区：仅用于实时提取 <think> 思考内容
        const chatTimer = debugTimer(`${_fn} chatOnce turn#${turn}`)
        log.trace("chat_store.send_message.trace", `[${_fn}] 第${turn}轮 chat() 发起请求...`, { fn: _fn, turn: turn })

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
                  log.debug("chat_store.send_message.debug", `[${_fn}] 第${turn}轮 <think> 标签检测到，提取 ${think.length} 字符`, { fn: _fn, turn: turn, think_length: think.length })
                }
                thinkSplitDone = true
                log.trace("chat_store.send_message.trace", `[${_fn}] 第${turn}轮 thinkSplitDone → true`, { fn: _fn, turn: turn })
                return
              }
              if (full.includes('<think>') && !full.includes('</think>')) {
                currentThinking.value = full.replace(/^[\s\S]*?<think>\s*/, '')
                log.trace("chat_store.send_message.trace", `[${_fn}] 第${turn}轮 thinking 累积中 (${currentThinking.value.length} 字符)`, { fn: _fn, turn: turn, current_thinking_value: currentThinking.value.length })
                return
              }
            }
          },
          onThinking: (t: string) => {
            currentThinking.value += t
            log.trace("chat_store.send_message.trace", `[${_fn}] onThinking 收到 ${t.length} 字符，累积 ${currentThinking.value.length} 字符`, { fn: _fn, t_length: t.length, current_thinking_value: currentThinking.value.length })
          },
        }

        const requestMessages = chatContext.getMessages(tools)
        syncContextStats()
        modelCallCount++
        const result = await chatOnce(
          requestMessages,
          tools,
          myAbort.signal,
          streamCallbacks,
        )
        chatTimer.stop()

        // ── 模型走了纯文本通道（没用 say = 兜底路径）────────
        if (result.type === 'done') {
          const finalText = result.text
          finalTextFromLoop = finalText
          log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 AI 纯文本回复(未走 say), 长度=${finalText?.length || 0}`, { fn: _fn, turn: turn, final_text_length: finalText?.length || 0 })
          log.debug("chat_store.send_message.debug", `[${_fn}] AI 回复前200字: "${(finalText || '').slice(0, 200)}"`, { fn: _fn, final_text_slice: (finalText || '').slice(0, 200) })

          // 兜底：不支持原生 FC 的模型可能把动作调用写在文字里
          const textCalls = agentService.extractTextToolCalls(finalText)
          if (textCalls.length > 0) {
            log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ✦ 文本动作调用: ${textCalls.length} 个`, { fn: _fn, turn: turn, text_calls_length: textCalls.length })
            isUsingTools.value = true
            currentBubbleText.value = ""
            const cleanText = agentService.stripTextToolCalls(finalText)
            // 与 FC 路径同范式：assistant 消息带 tool_calls（正文附剥离工具调用后的文本），
            // 随后逐个写 tool 回执。避免「无 tool_calls 的孤儿 tool 结果」导致下次请求 400。
            const textToolCallsData = textCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            }))
            chatContext.addAssistantToolCall(textToolCallsData, cleanText || undefined)
            syncContextStats()
            const toolImages: ImageAttachment[] = []
            for (let ti = 0; ti < textCalls.length; ti++) {
              const tc = textCalls[ti]
              toolCallCount++
              beginActivity(tc.id, tc.name || '?')
              log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ✦ 执行文本动作[${ti + 1}/${textCalls.length}]: ${tc.name || '?'}`, { fn: _fn, turn: turn, ti: ti + 1, text_calls_length: textCalls.length, tc_name: tc.name || '?' })
              const toolResult = await executeWithPolicy(tc)
              if (isToolError(toolResult)) toolFailureCount++
              if (collectToolImages(toolResult, toolImages)) {
                toolResult.content += `\n部分图片未附加：单轮最多 ${MAX_IMAGE_COUNT} 张且总计不超过 ${Math.floor(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)}MB。`
              }
              endActivity(tc.id, resultStatus(toolResult))
              chatContext.addToolResult(tc.id, toolResult.content)
              syncContextStats()
            }
            if (toolImages.length) {
              chatContext.addToolImages(textCalls.map(call => call.id).join(', '), toolImages)
              syncContextStats()
            }
            isUsingTools.value = false
            turnTimer.stop('text-tools — continue')
            continue
          }

          // 纯正文兜底：正文当显示文本，生成 TTS 安全的母语台词
          if (finalText && finalText.trim()) {
            fallbackUsed = true
            const { voiceLang, displayLang, persona } = getLangs()
            const translate: TranslateFn = (txt, target, opts) =>
              translateText(txt, target, { persona, signal: myAbort.signal, ttsSafe: opts?.ttsSafe })
            // 立即展示正文，voice 翻译异步进行，避免二次翻译阻塞文字回复。
            currentBubbleText.value = finalText
            isTyping.value = true
            finalTextFromLoop = finalText
            const { voice, display } = await resolveContentFallback(finalText, voiceLang, displayLang, translate)
            commitSyntheticSay(voice, display)
            deliver(voice, display)
            log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ✓ 纯正文兜底完成 (显示:${display.length}字, TTS:${voice.length}字)`, { fn: _fn, turn: turn, display_length: display.length, voice_length: voice.length })
          } else {
            log.warn("chat_store.send_message.warn", `[${_fn}] 第${turn}轮 ⚠ AI 返回空文本`, undefined, { fn: _fn, turn: turn })
          }
          turnTimer.stop('done — break')
          break
        }

        // ── 模型走了工具通道（say 和/或动作工具）──────────
        if (result.type === 'tools') {
          const { sayCall, actionCalls } = splitSayCalls(result.calls)
          log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ★ 工具调用: ${result.calls.length} 个 (say=${sayCall ? '有' : '无'}, 动作=${actionCalls.length})`, { fn: _fn, turn: turn, result_calls: result.calls.length, say_call: sayCall ? '有' : '无', action_calls_length: actionCalls.length })

          isUsingTools.value = actionCalls.length > 0
          currentBubbleText.value = ""

          // 只把「会写回执」的调用入上下文：动作工具 + 第一条 say。
          // 多余的 say 直接丢弃，否则会产生无回执的孤儿 tool_call id（下次请求 400）。
          const keptIds = new Set<string>()
          for (const c of actionCalls) if (c.id) keptIds.add(c.id)
          if (sayCall?.id) keptIds.add(sayCall.id)
          chatContext.addAssistantToolCall(result.calls.filter(c => c.id && keptIds.has(c.id)))
          syncContextStats()

          // 先执行动作工具（让立绘先变）
          const toolImages: ImageAttachment[] = []
          let actionBatchFailed = false
          for (let ti = 0; ti < actionCalls.length; ti++) {
            const tc = actionCalls[ti]
            toolCallCount++
            const toolTimer = debugTimer(`${_fn} tool#${ti} turn#${turn}`)
            const tcName = tc.function?.name || '?'
            beginActivity(tc.id, tcName)
            log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ★ 执行动作[${ti + 1}/${actionCalls.length}]: ${tcName} (id=${tc.id})`, { fn: _fn, turn: turn, ti: ti + 1, action_calls_length: actionCalls.length, tc_name: tcName, tc_id: tc.id })
            log.debug("chat_store.send_message.debug", `[${_fn}] 第${turn}轮 ★ 参数: ${(tc.function?.arguments || '{}').slice(0, 300)}`, { fn: _fn, turn: turn, tc_function: (tc.function?.arguments || '{}').slice(0, 300) })
            let toolCall: ToolCall
            try {
              toolCall = {
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}'),
              }
            } catch (parseErr) {
              toolFailureCount++
              actionBatchFailed = true
              log.error("chat_store.send_message.error", `[${_fn}] 第${turn}轮 ★ 工具参数 JSON 解析失败: ${(parseErr as Error).message}`, parseErr, { fn: _fn, turn: turn })
              endActivity(tc.id, 'error')
              chatContext.addToolResult(tc.id, '参数解析失败')
              syncContextStats()
              continue
            }
            const toolResult = await executeWithPolicy(toolCall)
            if (isToolError(toolResult)) {
              toolFailureCount++
              actionBatchFailed = true
            }
            if (collectToolImages(toolResult, toolImages)) {
              toolResult.content += `\n部分图片未附加：单轮最多 ${MAX_IMAGE_COUNT} 张且总计不超过 ${Math.floor(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)}MB。`
            }
            toolTimer.stop()
            endActivity(tc.id, resultStatus(toolResult))
            log.debug("chat_store.send_message.debug", `[${_fn}] 第${turn}轮 ★ 工具结果(${tcName}): ${(toolResult?.content || '').slice(0, 200)}`, { fn: _fn, turn: turn, tc_name: tcName, tool_result_content: (toolResult?.content || '').slice(0, 200) })
            chatContext.addToolResult(tc.id, toolResult.content)
            syncContextStats()
          }
          isUsingTools.value = false

          // 同批调用 say 时，模型尚未见到刚读取的图片，不能把预先生成的 say 当作读图结论。
          // 先为 say 写入回执以保持协议完整，再把图片交给下一轮模型观察。
          if (sayCall && (toolImages.length || actionBatchFailed)) {
            const reason = actionBatchFailed
              ? '未说出：需要先读取并处理刚才的工具失败结果，再生成最终答复。'
              : '未说出：需要先观察刚读取的图片，再生成最终答复。'
            chatContext.addToolResult(sayCall.id, reason)
            chatContext.addToolImages(actionCalls.map(call => call.id).join(', '), toolImages)
            syncContextStats()
            turnTimer.stop(actionBatchFailed ? 'tool-failed — continue' : 'tool-images — continue')
            continue
          }

          // ── say 出现 → 字段兜底 + 渲染 + TTS + 终止 ──────
          if (sayCall) {
            const { voiceLang, displayLang, persona } = getLangs()
            const translate: TranslateFn = (txt, target, opts) =>
              translateText(txt, target, { persona, signal: myAbort.signal, ttsSafe: opts?.ttsSafe })
            const raw = parseSayArgs(sayCall.function?.arguments || '{}')
            log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ✦ say 原始: voice=${raw.voice?.length || 0}字 display=${raw.display?.length || 0}字`, { fn: _fn, turn: turn, raw_voice: raw.voice?.length || 0, raw_display: raw.display?.length || 0 })
            // 立即展示 display，不阻塞在 voice 清洗/翻译上，降低打字到可见的首字延迟。
            const displayPreview = raw.display?.trim() || (voiceLang === displayLang ? raw.voice?.trim() : '')
            if (displayPreview) {
              currentBubbleText.value = displayPreview
              isTyping.value = true
              finalTextFromLoop = displayPreview
            }
            const { voice, display } = await resolveSayContent(raw, voiceLang, displayLang, translate)
            chatContext.addToolResult(sayCall.id, '已说出')  // 保持上下文合法
            syncContextStats()
            finalTextFromLoop = display
            if (voice || display) {
              deliver(voice, display)
              log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ✓ say 完成 (显示:${display.length}字, TTS:${voice.length}字)`, { fn: _fn, turn: turn, display_length: display.length, voice_length: voice.length })
            } else {
              log.warn("chat_store.send_message.warn", `[${_fn}] 第${turn}轮 ⚠ say 内容为空`, undefined, { fn: _fn, turn: turn })
            }
            turnTimer.stop('say — break')
            break
          }

          if (toolImages.length) {
            chatContext.addToolImages(actionCalls.map(call => call.id).join(', '), toolImages)
            syncContextStats()
            turnTimer.stop('tool-images — continue')
            continue
          }

          // ── 仅动作、无 say ──────────────────────────────
          // 动作后的正文不是最终答复，忽略并继续下一轮，让模型收尾调用 say 提交。
          if (result.text?.trim()) {
            log.debug("chat_store.send_message.debug", `[${_fn}] 第${turn}轮忽略工具执行前正文并继续`, {
              fn: _fn,
              turn,
              pre_tool_text_length: result.text.length,
            })
          }
          turnTimer.stop('actions — continue')
          log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ★ 仅动作无 say，继续下一轮`, { fn: _fn, turn: turn })
          continue
        }
      } catch (err) {
        const errMsg = (err as Error).message
        const errName = (err as Error).name
        if (errName === 'AbortError') {
          wasCancelled = true
          log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ⏹ 请求被取消 (AbortError)`, { fn: _fn, turn: turn })
          break
        }
        log.error("chat.turn_failed", "对话执行失败", err, {
          operation: _fn,
          turn,
          requestId,
        })
        failed = true
        showBubbleText(t('app.bubble.error', { msg: errMsg }), false)
        break
      }
    }

    // ── 循环结束 ────────────────────────────────────────
    // 若本次请求已被取消/被新请求取代（abortController 已不是 myAbort），
    // 则跳过收尾，避免覆盖新请求的状态或弹出误导性兜底气泡。
    if (abortController !== myAbort) {
      log.info("chat.request_cancelled", "对话请求被替代或取消", { requestId })
      log.info("chat_store.send_message.info", `[${_fn}] ◀ 本次请求已被取消或被新请求取代，跳过收尾`, { fn: _fn })
      _timer.stop()
      return true
    }

    if (wasCancelled) {
      // 用户主动取消：不展示兜底气泡
      log.info("chat_store.send_message.info", `[${_fn}] 已取消，跳过兜底提示`, { fn: _fn })
    } else if (!currentBubbleText.value) {
      // 模型始终未调 say 就触达安全上限（异常：通常是模型陷入工具死循环），展示兜底提示
      log.warn("chat_store.send_message.warn", `[${_fn}] ⚠ 触达工具循环安全上限 ${toolTurns} 轮仍无 say，展示兜底提示 (finalTextFromLoop=${finalTextFromLoop ? '有' : '无'})`, undefined, { fn: _fn, tool_turns: toolTurns, final_text_from_loop: finalTextFromLoop ? '有' : '无' })
      showBubbleText(t('app.bubble.done'), false)
    } else {
      log.debug("chat_store.send_message.debug", `[${_fn}] 循环结束，气泡已设置 (${currentBubbleText.value.length}字)`, { fn: _fn, current_bubble_text_value: currentBubbleText.value.length })
    }

    isProcessing.value = false
    abortController = null
    log.debug("chat_store.send_message.debug", `[${_fn}] isProcessing → false abortController → null`, { fn: _fn })

    // 工具活动列表：本次有调用则保留一会儿供用户回看，再淡出；无调用则立即隐藏
    if (toolActivities.value.length > 0) {
      if (toolHideTimer !== null) clearTimeout(toolHideTimer)
      toolHideTimer = setTimeout(() => { showToolActivity.value = false; toolHideTimer = null }, 5000)
    } else {
      showToolActivity.value = false
    }

    // 即使本轮没有最终 say（错误、上限或仅工具），也保存脱敏后的工具上下文，
    // 避免重启后完全丢失已经完成的操作事实。
    useSessionStore().saveCurrentSession()

    // 完成状态分级：取消 > 硬错误 > 有工具失败但仍有输出 > 全部成功
    const completionStatus: 'success' | 'partial_success' | 'failed' | 'cancelled' =
      wasCancelled ? 'cancelled'
      : failed ? 'failed'
      : toolFailureCount > 0 ? 'partial_success'
      : 'success'
    const completedContext = {
      requestId,
      completionStatus,
      failed,
      cancelled: wasCancelled,
      durationMs: Math.round(performance.now() - requestStartedAt),
      turnsUsed,
      toolTurnLimit: toolTurns,
      toolDefinitionCount: tools.length,
      modelCallCount,
      toolCallCount,
      toolFailureCount,
      fallbackUsed,
      ttsStatus,
    }
    if (failed) {
      log.error('chat.request_completed', '对话请求结束', new Error('对话请求失败'), completedContext)
    } else {
      log.info('chat.request_completed', '对话请求结束', completedContext)
    }

    _timer.stop()
    log.trace("chat_store.send_message.trace", `[${_fn}] ◀ (正常结束)`, { fn: _fn })
    return !failed
  }

  /** 触发角色 TTS 语音播报 */
  let lastTtsText = ''
  async function triggerTts(text: string): Promise<TtsPlaybackStatus | 'idle'> {
    const _fn = 'triggerTts'
    log.trace("chat_store.trigger_tts.trace", `[${_fn}] ▶ 播报文本(${text.length}字)`, { fn: _fn, text_length: text.length })

    // 去重：连续播报相同文本跳过
    if (text === lastTtsText) {
      log.trace("chat_store.trigger_tts.trace", `[${_fn}] 跳过重复播报: text === lastTtsText`, { fn: _fn })
      return 'idle'
    }

    try {
      const charStore = useCharacterStore()
      const provider = getTtsProvider()
      const voiceId = charStore.data?.voice

      if (provider === 'none') {
        log.trace("chat_store.trigger_tts.trace", `[${_fn}] TTS 已禁用（提供者为 none），跳过`, { fn: _fn })
        return 'skipped'
      }
      // CosyVoice 需要 voiceId；GPT-SoVITS 不需要
      if (provider === 'cosyvoice' && !voiceId) {
        log.trace("chat_store.trigger_tts.trace", `[${_fn}] 无 voiceId 配置，跳过 TTS`, { fn: _fn })
        return 'skipped'
      }
      const voiceLang = charStore.data?.voiceLanguage || '?'
      log.info("chat_store.trigger_tts.info", `[${_fn}] 开始 TTS 播报: voiceId=${voiceId} lang=${voiceLang} text=${text.length}字`, { fn: _fn, voice_id: voiceId, voice_lang: voiceLang, text_length: text.length })
      const ttsTimer = debugTimer(_fn)
      const result = await speakTextStreaming(text, voiceId || '')
      ttsTimer.stop()

      switch (result.status) {
        case 'played':
          // 仅实际播报成功后记去重，失败/跳过都允许重试同一文本
          lastTtsText = text
          log.info("chat_store.trigger_tts.info", `[${_fn}] ✓ TTS 播报完成 (${text.length}字)`, { fn: _fn, text_length: text.length })
          break
        case 'skipped':
          log.info("chat_store.trigger_tts.info", `[${_fn}] ⏭ TTS 已跳过: ${result.reason ?? 'unknown'}`, { fn: _fn, tts_reason: result.reason })
          break
        case 'failed':
          log.warn("chat_store.trigger_tts.warn", `[${_fn}] ⚠ TTS 播报失败: ${result.reason ?? 'unknown'}`, undefined, { fn: _fn, tts_reason: result.reason })
          break
        case 'cancelled':
          lastTtsText = '' // 取消后允许重试，重置去重
          log.info("chat_store.trigger_tts.info", `[${_fn}] ⏹ TTS 播报被取消`, { fn: _fn })
          break
      }
      return result.status
    } catch (err) {
      log.warn("chat_store.trigger_tts.warn", `[${_fn}] ⚠ TTS 播报异常 (静默): ${(err as Error).message}`, err, { fn: _fn })
      return 'failed'
    } finally {
      log.trace("chat_store.trigger_tts.trace", `[${_fn}] ◀`, { fn: _fn })
    }
  }

  function cancelResponse() {
    const _fn = 'cancelResponse'
    log.trace("chat_store.cancel_response.trace", `[${_fn}] ▶`, { fn: _fn })
    log.debug("chat_store.cancel_response.debug", `[${_fn}] 取消前状态: isProcessing=${isProcessing.value} isUsingTools=${isUsingTools.value} abortController=${abortController ? '存在' : 'null'}`, { fn: _fn, is_processing_value: isProcessing.value, is_using_tools_value: isUsingTools.value, abort_controller: abortController ? '存在' : 'null' })

    // 兜底拒绝待确认的操作，解除工具循环的 await
    rejectPendingConfirm()
    rejectPendingCommandConfirm()
    rejectPendingScreenCaptureConfirm()

    if (abortController) {
      log.trace("chat_store.cancel_response.trace", `[${_fn}] 调用 abortController.abort()`, { fn: _fn })
      abortController.abort()
      abortController = null
      log.trace("chat_store.cancel_response.trace", `[${_fn}] abortController → null`, { fn: _fn })
    } else {
      log.trace("chat_store.cancel_response.trace", `[${_fn}] abortController 已为 null`, { fn: _fn })
    }

    isProcessing.value = false
    isUsingTools.value = false
    cancelSpeak()
    // 取消后重置 TTS 去重，以便重试时能再次播报被取消的同一段文本
    lastTtsText = ''
    // 隐藏正在生成的气泡与思考过程，避免残留半截内容
    hideBubble()
    currentThinking.value = ''
    log.info("chat_store.cancel_response.info", `[${_fn}] ✓ AI 回复已取消 (isProcessing=${isProcessing.value} isUsingTools=${isUsingTools.value})`, { fn: _fn, is_processing_value: isProcessing.value, is_using_tools_value: isUsingTools.value })
    log.trace("chat_store.cancel_response.trace", `[${_fn}] ◀`, { fn: _fn })
  }

  function addMessage(
    role: ChatMessage['role'],
    text: string,
    thinking?: string,
    voice?: string,
    images?: ImageAttachment[],
  ): string {
    const _fn = 'addMessage'
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const msgLen = text.length
    const thinkLen = thinking?.length || 0

    log.trace("chat_store.add_message.trace", `[${_fn}] ▶ role=${role} text=${msgLen}字 thinking=${thinkLen}字`, { fn: _fn, role: role, msg_len: msgLen, think_len: thinkLen })
    log.debug("chat_store.add_message.debug", `[${_fn}] 消息ID=${id} role=${role} text="${text.slice(0, 60)}"`, { fn: _fn, id: id, role: role, text_slice: text.slice(0, 60) })

    // assistant 消息记录当时的角色身份快照；旧会话数据无此字段，界面按当前角色回退
    const identity = role === 'assistant' ? characterIdentity?.() ?? null : null
    messages.value.push({
      id,
      role,
      text,
      thinking: thinking || undefined,
      voice: voice || undefined,
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
      charId: identity?.id,
      charName: identity?.name,
    })

    log.debug("chat_store.add_message.debug", `[${_fn}] ✓ 已添加: 当前消息总数=${messages.value.length} 最新ID=${id}`, { fn: _fn, messages_value: messages.value.length, id: id })

    // 保存到当前会话
    const saveTimer = debugTimer(`${_fn} saveSession`)
    useSessionStore().saveCurrentSession()
    saveTimer.stop()
    log.trace("chat_store.add_message.trace", `[${_fn}] ◀`, { fn: _fn })
    return id
  }

  function clearMessages() {
    const _fn = 'clearMessages'
    const prevCount = messages.value.length
    log.trace("chat_store.clear_messages.trace", `[${_fn}] ▶ (当前消息数=${prevCount})`, { fn: _fn, prev_count: prevCount })

    // 先取消正在进行中的 AI 请求，避免其回调写入已被清空的上下文
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    rejectPendingConfirm()
    rejectPendingCommandConfirm()
    rejectPendingScreenCaptureConfirm()
    autoExecSession.value = false
    isProcessing.value = false
    isUsingTools.value = false
    hideBubble()
    currentThinking.value = ''

    if (prevCount > 0) {
      log.debug("chat_store.clear_messages.debug", `[${_fn}] 最后一条消息: role=${messages.value[prevCount - 1]?.role || '?'} text="${(messages.value[prevCount - 1]?.text || '').slice(0, 50)}"`, { fn: _fn, messages_value: messages.value[prevCount - 1]?.role || '?', messages_value2: (messages.value[prevCount - 1]?.text || '').slice(0, 50) })
    }

    messages.value = []
    log.trace("chat_store.clear_messages.trace", `[${_fn}] messages → []`, { fn: _fn })

    chatContext = createChatContext()
    currentPersona = null
    syncContextStats()
    log.trace("chat_store.clear_messages.trace", `[${_fn}] chatContext → createChatContext()`, { fn: _fn })

    // 保存清空状态到当前会话
    useSessionStore().saveCurrentSession()
    // 清空本会话的回档检查点与文件备份
    void useSessionStore().clearCheckpoints()
    log.info("chat_store.clear_messages.info", `[${_fn}] ✓ 已清空 ${prevCount} 条聊天记录`, { fn: _fn, prev_count: prevCount })
    log.trace("chat_store.clear_messages.trace", `[${_fn}] ◀`, { fn: _fn })
  }

  function resetContext() {
    const _fn = 'resetContext'
    log.trace("chat_store.reset_context.trace", `[${_fn}] ▶`, { fn: _fn })
    const oldContext = chatContext
    chatContext = createChatContext()
    currentPersona = null
    syncContextStats()
    log.debug("chat_store.reset_context.debug", `[${_fn}] ✓ 对话上下文已重置 (old context=${oldContext.constructor.name})`, { fn: _fn, old_context_constructor: oldContext.constructor.name })
    log.trace("chat_store.reset_context.trace", `[${_fn}] ◀`, { fn: _fn })
  }

  /**
   * 加载历史消息（会话切换时使用）
   * 保留 system prompt，清除当前消息并用历史消息重建 AI 上下文
   */
  function loadMessages(msgs: ChatMessage[], snapshot?: ChatContextSnapshot | null) {
    const _fn = 'loadMessages'
    log.trace("chat_store.load_messages.trace", `[${_fn}] ▶ msgs.length=${msgs.length}`, { fn: _fn, msgs_length: msgs.length })

    // 统计消息组成
    const userCount = msgs.filter(m => m.role === 'user').length
    const asstCount = msgs.filter(m => m.role === 'assistant').length
    log.debug("chat_store.load_messages.debug", `[${_fn}] 消息组成: user=${userCount} assistant=${asstCount} 总计=${msgs.length}`, { fn: _fn, user_count: userCount, asst_count: asstCount, msgs_length: msgs.length })

    if (msgs.length > 0) {
      log.debug("chat_store.load_messages.debug", `[${_fn}] 首条消息: role=${msgs[0].role} text="${msgs[0].text.slice(0, 50)}"`, { fn: _fn, msgs_role: msgs[0].role, msgs_text: msgs[0].text.slice(0, 50) })
      log.debug("chat_store.load_messages.debug", `[${_fn}] 末条消息: role=${msgs[msgs.length - 1].role} text="${msgs[msgs.length - 1].text.slice(0, 50)}"`, { fn: _fn, msgs_msgs: msgs[msgs.length - 1].role, msgs_msgs2: msgs[msgs.length - 1].text.slice(0, 50) })
    }

    messages.value = [...msgs]
    log.trace("chat_store.load_messages.trace", `[${_fn}] messages 已替换（当前 ${messages.value.length} 条）`, { fn: _fn, messages_value: messages.value.length })

    // 重置气泡和 AI 上下文
    hideBubble()
    showInput.value = false
    currentThinking.value = ''
    isProcessing.value = false
    isUsingTools.value = false
    // 切换/恢复会话：解除待确认项，并重置「本会话自动允许」
    rejectPendingConfirm()
    rejectPendingCommandConfirm()
    rejectPendingScreenCaptureConfirm()
    autoExecSession.value = false
    log.trace("chat_store.load_messages.trace", `[${_fn}] 气泡状态已重置: hideBubble showInput=false thinking=""`, { fn: _fn })

    if (abortController) {
      log.trace("chat_store.load_messages.trace", `[${_fn}] 取消进行中的请求 (abortController.abort())`, { fn: _fn })
      abortController.abort()
      abortController = null
    }
    chatContext.reset()
    syncContextStats()
    log.trace("chat_store.load_messages.trace", `[${_fn}] ChatContext 已重置`, { fn: _fn })

    if (snapshot && chatContext.importSnapshot(snapshot)) {
      chatContext.restoreUserImages(msgs
        .filter(msg => msg.role === 'user')
        .map(msg => ({ text: msg.text, images: msg.images })))
      syncContextStats()
      log.info("chat_store.load_messages.info", `[${_fn}] ✓ 已恢复持久化协议上下文（${snapshot.messages.length} 条）`, { fn: _fn, snapshot_messages: snapshot.messages.length })
    } else {

    // 旧会话兼容：重放界面消息到 AI 上下文。
    // 关键：助手回合必须重建为 say 工具调用（而非纯文本）。否则恢复出的历史会呈现
    // “助手只用纯文本回复、从不调用工具”的范式，模型会模仿它而忘记调用 say/动作工具
    // （会话切走再切回后表现为“忘记使用工具”）。
    log.trace("chat_store.load_messages.trace", `[${_fn}] 开始重放 ${msgs.length} 条消息到 ChatContext...`, { fn: _fn, msgs_length: msgs.length })
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      if (msg.role === 'user') {
        chatContext.addUserMessage(msg.text, msg.images)
        log.trace("chat_store.load_messages.trace", `[${_fn}]   [${i + 1}/${msgs.length}] user → context: "${msg.text.slice(0, 40)}"`, { fn: _fn, i: i + 1, msgs_length: msgs.length, msg_text: msg.text.slice(0, 40) })
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
        log.trace("chat_store.load_messages.trace", `[${_fn}]   [${i + 1}/${msgs.length}] assistant → say 调用重建: "${msg.text.slice(0, 40)}"`, { fn: _fn, i: i + 1, msgs_length: msgs.length, msg_text: msg.text.slice(0, 40) })
      }
    }
      syncContextStats()
      log.debug("chat_store.load_messages.debug", `[${_fn}] ✓ 旧会话消息重放完成（助手回合已重建为 say 调用）`, { fn: _fn })
    }

    // 会话切换后，气泡显示目标会话的最后一条 AI 消息（含思考过程）
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
    if (lastAssistant) {
      currentThinking.value = lastAssistant.thinking || ''
      showBubbleText(lastAssistant.text, false)
      log.debug("chat_store.load_messages.debug", `[${_fn}] ✓ 显示最后AI消息: text="${lastAssistant.text.slice(0, 40)}" thinking=${lastAssistant.thinking ? `${lastAssistant.thinking.length}字` : '无'}`, { fn: _fn, last_assistant_text: lastAssistant.text.slice(0, 40), last_assistant_thinking: lastAssistant.thinking ? `${lastAssistant.thinking.length}字` : '无' })
    } else {
      log.trace("chat_store.load_messages.trace", `[${_fn}] 无历史 AI 消息，气泡保持隐藏`, { fn: _fn })
    }
    log.info("chat_store.load_messages.info", `[${_fn}] ✓ 已加载会话消息: ${msgs.length} 条 (user=${userCount} asst=${asstCount}), 最后AI消息 ${lastAssistant ? `${lastAssistant.text.length} 字` : '无'}`, { fn: _fn, msgs_length: msgs.length, user_count: userCount, asst_count: asstCount, last_assistant_length: lastAssistant?.text.length ?? 0 })
    log.trace("chat_store.load_messages.trace", `[${_fn}] ◀`, { fn: _fn })
  }

  /** 更新角色 system prompt（含语言配置） */
  function setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string, render?: 'illustration' | 'live2d') {
    const _fn = 'setSystemPrompt'
    log.trace("chat_store.set_system_prompt.trace", `[${_fn}] ▶ prompt=${prompt?.length || 0}字 voiceLang=${voiceLang || '?'} displayLang=${displayLang || '?'}`, { fn: _fn, prompt_length: prompt?.length || 0, voice_lang: voiceLang || '?', display_lang: displayLang || '?' })
    log.debug("chat_store.set_system_prompt.debug", `[${_fn}] prompt前50字: "${(prompt || '').slice(0, 50)}"`, { fn: _fn, prompt_slice: (prompt || '').slice(0, 50) })
    currentPersona = { prompt, voiceLang, displayLang, render }
    chatContext.setSystemPrompt(prompt, voiceLang, displayLang, render)
    syncContextStats()
    log.debug("chat_store.set_system_prompt.debug", `[${_fn}] ✓ system prompt 已更新`, { fn: _fn })
    log.trace("chat_store.set_system_prompt.trace", `[${_fn}] ◀`, { fn: _fn })
  }

  /** API 模型变更后重建预算，但保留当前脱敏协议上下文与角色人格。 */
  function refreshModelContext() {
    const snapshot = chatContext.exportSnapshot()
    chatContext = createChatContext()
    if (currentPersona) {
      chatContext.setSystemPrompt(
        currentPersona.prompt,
        currentPersona.voiceLang,
        currentPersona.displayLang,
        currentPersona.render,
      )
    }
    chatContext.importSnapshot(snapshot)
    chatContext.restoreUserImages(messages.value
      .filter(msg => msg.role === 'user')
      .map(msg => ({ text: msg.text, images: msg.images })))
    configReady.value = isConfigValid(loadConfig())
    syncContextStats()
    useSessionStore().saveCurrentSession()
    log.info("chat_store.refresh_model_context.info", `模型配置已刷新，上下文预算=${contextStats.value.maxContextTokens}`, { context_stats_value: contextStats.value.maxContextTokens })
  }

  function exportContext(): ChatContextSnapshot {
    return chatContext.exportSnapshot()
  }

  /**
   * 返回下一次模型请求可见的完整上下文视图。
   * 不写入磁盘，不含 API Key；图片只保留 MIME 与体积说明。
   */
  function inspectContext(): CurrentContextInspection {
    const tools = [...agentService.getToolDefinitions(useCharacterStore().data), SAY_TOOL_DEF] as ToolDefinition[]
    const config = loadConfig()
    return {
      ...chatContext.inspect(tools),
      capturedAt: Date.now(),
      model: config.model || '',
      endpoint: config.baseURL || '',
      toolDefinitions: tools,
      persona: currentPersona
        ? {
          voiceLang: currentPersona.voiceLang || '',
          displayLang: currentPersona.displayLang || '',
          render: currentPersona.render ?? 'illustration',
        }
        : null,
      runtime: {
        processing: isProcessing.value,
        usingTools: isUsingTools.value,
        activities: toolActivities.value.map(activity => ({ ...activity })),
        pendingConfirmation: (pendingScreenCaptureConfirm.value ?? pendingCommandConfirm.value ?? pendingConfirm.value)
          ? {
            toolName: (pendingScreenCaptureConfirm.value ?? pendingCommandConfirm.value ?? pendingConfirm.value)!.toolName,
            path: pendingScreenCaptureConfirm.value?.target
              ?? (pendingCommandConfirm.value ?? pendingConfirm.value)?.path
              ?? '',
          }
          : null,
        autoExecSession: autoExecSession.value,
      },
    }
  }

  function showBubbleText(text: string, typing: boolean = true) {
    const _fn = 'showBubbleText'
    log.trace("chat_store.show_bubble_text.trace", `[${_fn}] text=${text.length}字 typing=${typing} text="${text.slice(0, 50)}"`, { fn: _fn, text_length: text.length, typing: typing, text_slice: text.slice(0, 50) })
    currentBubbleText.value = text
    isTyping.value = typing
    showBubble.value = true
    log.debug("chat_store.show_bubble_text.debug", `[${_fn}] ✓ showBubble=${showBubble.value} isTyping=${isTyping.value}`, { fn: _fn, show_bubble_value: showBubble.value, is_typing_value: isTyping.value })
  }

  function hideBubble() {
    const _fn = 'hideBubble'
    log.trace("chat_store.hide_bubble.trace", `[${_fn}] ▶ (当前文本=${currentBubbleText.value.length}字)`, { fn: _fn, current_bubble_text_value: currentBubbleText.value.length })
    currentBubbleText.value = ""
    isTyping.value = false
    showBubble.value = false
    log.trace("chat_store.hide_bubble.trace", `[${_fn}] ◀ 气泡已隐藏`, { fn: _fn })
  }

  function toggleInput() {
    showInput.value = !showInput.value
    log.trace("chat_store.toggle_input.trace", `[toggleInput] showInput → ${showInput.value}`, { show_input_value: showInput.value })
  }

  function openInput() {
    showInput.value = true
    log.trace("chat_store.open_input.trace", "[openInput] showInput → true")
  }

  function closeInput() {
    showInput.value = false
    log.trace("chat_store.close_input.trace", "[closeInput] showInput → false")
  }

  return {
    messages,
    contextStats,
    isProcessing,
    currentBubbleText,
    currentThinking,
    isTyping,
    showBubble,
    showInput,
    configReady,
    isUsingTools,
    toolActivities,
    showToolActivity,
    pendingConfirm,
    pendingCommandConfirm,
    pendingScreenCaptureConfirm,
    autoExecSession,
    resolveConfirm,
    resolveCommandConfirm,
    resolveScreenCaptureConfirm,
    init,
    sendMessage,
    cancelResponse,
    addMessage,
    clearMessages,
    resetContext,
    loadMessages,
    setSystemPrompt,
    refreshModelContext,
    exportContext,
    inspectContext,
    showBubbleText,
    hideBubble,
    toggleInput,
    openInput,
    closeInput,
  }
})
