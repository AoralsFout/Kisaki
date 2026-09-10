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
import { ApprovalGateway, type ApprovalDecision, type ApprovalRequest } from '../application/tools/approvalGateway'
import { ToolExecutionCoordinator } from '../application/tools/toolExecutionCoordinator'
import { toolExecutionPolicy } from '../agent/toolExecutionPolicy'
import { speakTextStreaming, cancelSpeak, getTtsProvider, isTtsEnabled } from '../tts'
import type { TtsPlaybackStatus } from '../tts'
import { useCharacterStore } from '../character'
import { createLogger } from '../utils/logger'
import { t } from '../i18n'
import type { ChatSessionPort } from '../application/conversation/chatSessionPort'
import {
  ConversationCoordinator,
  type ConversationRun,
  type ConversationRunState,
  isConversationRunActive,
  isConversationRunUsingTools,
} from '../application/conversation/conversationRun'
import {
  ModelStreamDecoder,
  extractPartialSayArgs,
  parseSayArgs,
} from '../application/conversation/modelStreamDecoder'
import {
  executeToolCallBatch,
  type ToolCallBatch,
} from '../application/conversation/toolCallBatch'
import { interpretModelTurn } from '../application/conversation/modelTurnInterpreter'
import {
  AssistantMessageCoordinator,
  type AssistantMessageSource,
} from '../application/conversation/assistantMessageCoordinator'
import { DEFAULT_VOICE_LANGUAGE } from '../constants'
import { resolveDisplayLanguage } from './language'

export { extractPartialSayArgs, parseSayArgs } from '../application/conversation/modelStreamDecoder'

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
    runState: ConversationRunState
    processing: boolean
    usingTools: boolean
    activities: ToolActivity[]
    pendingConfirmation: { toolName: string; path: string } | null
    autoExecSession: boolean
  }
}

/** 角色身份来源：由 App 注入（避免 store 直接依赖 Pinia 角色状态） */
let characterIdentity: (() => { id: string; name: string } | null) | null = null

const detachedSessionPort: ChatSessionPort = {
  currentSessionId: () => '',
  workspaceGrantId: () => null,
  acceptUserMessage: async () => true,
  recordToolCalls: async () => true,
  recordToolResult: async () => true,
  commitAssistantMessage: async () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  reviseAssistantMessage: async () => true,
  beginCheckpoint: async (_sessionId, messageId) => messageId,
  backupFile: async () => {},
  markCheckpointFiles: async () => {},
  clearConversation: async () => {},
}

let chatSessionPort: ChatSessionPort = detachedSessionPort

/** Installed by the composition owner; ChatStore never imports SessionStore directly. */
export function setChatSessionPort(port: ChatSessionPort | null): void {
  chatSessionPort = port ?? detachedSessionPort
}

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

/** voice 允许 Unicode 文字、数字、普通空格、半角逗号和数字常用符号。 */
function isTtsSafeVoice(text: string): boolean {
  if (!/^[\p{L}\p{M}\p{Nd} .,%:+\/\-]*$/u.test(text)) return false

  // 点号、百分号、冒号、斜杠和正负号仅用于数字表达式。
  // 若符号两侧都没有数字，则更可能是 URL、文件路径、代码或缩写，必须交给模型
  // 做语义改写，而不能直接送入 TTS。
  const chars = Array.from(text)
  const numericSymbols = new Set(['.', '%', ':', '+', '/', '-'])
  const isDigit = (value?: string) => Boolean(value && /^\p{Nd}$/u.test(value))
  return chars.every((char, index) => (
    !numericSymbols.has(char)
    || isDigit(chars[index - 1])
    || isDigit(chars[index + 1])
  ))
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
 * 只接受文字、数字、空白、半角逗号、常见中日句读符号和数字常用符号。
 * 网址、代码或其他特殊符号仍返回 null，交给翻译模型按语义改写。
 *
 * @internal 导出以支持单元测试
 */
export function normalizeTtsSafeVoice(text: string, voiceLang: string): string | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return ''
  if (!/^[\p{L}\p{M}\p{Nd}\s,、，。！？；：.%:+\/\-]*$/u.test(trimmed)) return null

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
  callbacks: {
    onThinking: (t: string) => void
    onChunk: (t: string) => void
    onToolCallDelta?: (calls: ToolCallData[]) => void
  },
  telemetry: { requestId: string; turn: number },
): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    chat(
      messages,
      {
        onChunk: callbacks.onChunk,
        onThinking: callbacks.onThinking,
        onToolCallDelta: callbacks.onToolCallDelta,
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
      undefined,
      telemetry,
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
  const conversationRunState = ref<ConversationRunState>('idle')
  let chatContext = createChatContext()
  const conversationCoordinator = new ConversationCoordinator(Date.now, {
    session: {
      recordToolCalls: input => chatSessionPort.recordToolCalls(input),
      recordToolResult: input => chatSessionPort.recordToolResult(input),
    },
    modelContext: {
      addToolCalls: (calls, visibleText) => {
        chatContext.addAssistantToolCall([...calls], visibleText)
        syncContextStats()
      },
      addToolResult: (callId, content) => {
        chatContext.addToolResult(callId, content)
        syncContextStats()
      },
      addToolImages: (toolCallIds, images) => {
        chatContext.addToolImages(toolCallIds, images)
        syncContextStats()
      },
    },
  })
  conversationCoordinator.subscribe(snapshot => {
    const state = snapshot?.state ?? 'idle'
    conversationRunState.value = state
    isProcessing.value = isConversationRunActive(state)
    isUsingTools.value = isConversationRunUsingTools(state)
  })
  const assistantMessageCoordinator = new AssistantMessageCoordinator({
    commit: async message => {
      if (chatSessionPort.currentSessionId() !== message.sessionId) return null
      const messageId = await chatSessionPort.commitAssistantMessage(message)
      if (!messageId) return null
      return addMessage('assistant', message.display, message.thinking, message.voice, undefined, messageId)
    },
    revise: async revision => {
      if (chatSessionPort.currentSessionId() !== revision.sessionId) return false
      if (!await chatSessionPort.reviseAssistantMessage(revision)) return false
      const message = messages.value.find(item => item.id === revision.messageId)
      if (!message) return false
      if (revision.voice !== undefined) message.voice = revision.voice
      if (revision.display !== undefined) message.text = revision.display
      return true
    },
  })
  assistantMessageCoordinator.subscribe(event => {
    if (event.playbackText?.trim()) void triggerTts(event.playbackText, event.requestId)
  })

  // ── 工具调用过程展示（主窗口右侧列表，仅处理时临时展示，不持久化） ──
  /** 单条工具调用活动 */
  const toolActivities = ref<ToolActivity[]>([])
  /** 是否显示工具活动列表（处理时点亮，完成后延时淡出） */
  const showToolActivity = ref(false)

  // ── 统一批准请求（文件 / 命令 / 屏幕截图） ──
  const pendingApproval = ref<ApprovalRequest | null>(null)
  /** 本会话内自动允许（运行时，不持久化；清空 / 切换会话时重置） */
  const autoExecSession = ref(false)
  const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000
  const approvalGateway = new ApprovalGateway(CONFIRM_TIMEOUT_MS, request => {
    log.warn('chat_store.approval_timeout', `工具批准超时，自动拒绝: ${request.toolName}`, undefined, {
      tool_name: request.toolName,
      approval_kind: request.kind,
      confirm_timeout_ms: CONFIRM_TIMEOUT_MS,
    })
  })
  approvalGateway.subscribe(request => {
    pendingApproval.value = request
    const active = conversationCoordinator.current()
    if (!active) return
    if (request) {
      conversationCoordinator.transition(active.id, 'awaiting-approval')
    } else if (active.state === 'awaiting-approval') {
      conversationCoordinator.transition(active.id, 'executing-tools')
    }
  })

  function resolveApproval(decision: ApprovalDecision): boolean {
    return approvalGateway.resolve(decision)
  }

  function rejectPendingApproval(): void {
    approvalGateway.rejectPending()
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
  function isToolError(result: Pick<ToolResult, 'ok' | 'content' | 'code'>): boolean {
    if (isToolSkipped(result)) return false
    if (typeof result.ok === 'boolean') return !result.ok
    return /^(工具执行错误|工具执行失败|错误[:：])/.test(result.content || '')
  }

  /** 工具结果是否为「被用户拒绝」（executeWithPolicy 拒绝时的前缀） */
  function isToolSkipped(result: Pick<ToolResult, 'content' | 'code'>): boolean {
    return result.code === 'USER_REJECTED' || /^用户已拒绝/.test(result.content || '')
  }

  /** 由工具结果内容推断活动状态 */
  function resultStatus(result: Pick<ToolResult, 'ok' | 'content' | 'code'>): ToolActivity['status'] {
    if (isToolSkipped(result)) return 'skipped'
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
  /** 可见回复已提交后仍在后台准备语音的请求控制器 */
  let backgroundVoiceRun: ConversationRun | null = null

  function cancelBackgroundVoicePreparation() {
    if (!backgroundVoiceRun) return
    const run = backgroundVoiceRun
    backgroundVoiceRun = null
    run.cancel('voice-preparation-superseded')
  }
  /** 工具活动列表淡出延时器（处理结束后保留一会儿再隐藏） */
  let toolHideTimer: ReturnType<typeof setTimeout> | null = null

  function init() {
    log.trace("chat_store.init.trace", "[init] ▶")
    const timer = debugTimer('init')
    const cfg = loadConfig()
    const valid = isConfigValid(cfg)
    configReady.value = valid
    log.info("chat_store.init.info", `[init] ChatStore 初始化, 配置${valid ? '' : '未'}就绪`, { valid: valid ? '' : '未' })
    log.debug("chat_store.init.debug", `[init] 配置详情: model=${cfg.model || '(未设置)'} hasKey=${cfg.apiKey ? '✓' : '✗'}`, { cfg_model: cfg.model || '(未设置)', has_api_key: Boolean(cfg.apiKey) })
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
    // 新消息到来时取消上一轮尚未完成的语音清洗/TTS 准备，避免旧语音覆盖新回复。
    cancelBackgroundVoicePreparation()

    const requestId = globalThis.crypto.randomUUID()
    const conversationRun = conversationCoordinator.start(requestId)
    const userText = rawText.trim() || t('chat.input.imageOnlyPrompt')
    log.debug("chat_store.send_message.debug", `[${_fn}] ConversationRun → preparing`, { fn: _fn, request_id: requestId })

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
      conversationCoordinator.transition(requestId, 'failed', 'network-unavailable')
      log.trace("chat_store.send_message.trace", `[${_fn}] ◀ (网络不可用)`, { fn: _fn })
      return false
    }

    const cfgCheck = loadConfig()
    if (!isConfigValid(cfgCheck)) {
      log.warn("chat_store.send_message.warn", `[${_fn}] ✗ API 未配置`, undefined, { fn: _fn, model: cfgCheck.model || '?', has_api_key: Boolean(cfgCheck.apiKey), has_base_url: Boolean(cfgCheck.baseURL) })
      showBubbleText(t('app.bubble.apiNotConfigured'), false)
      conversationCoordinator.transition(requestId, 'failed', 'invalid-configuration')
      log.trace("chat_store.send_message.trace", `[${_fn}] ◀ (配置无效)`, { fn: _fn })
      return false
    }

    const requestStartedAt = performance.now()
    let modelCallCount = 0
    let toolCallCount = 0
    let toolFailureCount = 0
    let turnsUsed = 0
    let fallbackUsed = false
    let ttsRequested = false
    let deliveredFinal = false
    let terminalReason: 'completed' | 'cancelled' | 'error' | 'empty_response' | 'tool_turn_limit' = 'completed'
    const requestSessionId = chatSessionPort.currentSessionId()
    log.info("chat.request_started", "对话请求开始", {
      requestId,
      textLength: rawText.length,
      imageCount: images.length,
      model: cfgCheck.model,
    })

    log.info("chat_store.send_message.info", `[${_fn}] 用户消息: ${userText.length} 字符${images.length ? ` + ${images.length} 图` : ''}`, { fn: _fn, user_text_length: userText.length, images_length: images.length })
    log.debug("chat_store.send_message.debug", `[${_fn}] 消息长度: ${userText.length} 字符, 图片: ${images.length} 张`, { fn: _fn, user_text_length: userText.length, images_length: images.length })

    // ── 先提交会话事实，再更新当前 UI 投影 ───────────────
    const userMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const accepted = await chatSessionPort.acceptUserMessage({
      sessionId: requestSessionId,
      messageId: userMsgId,
      text: userText,
      images,
    })
    if (!accepted) {
      conversationCoordinator.transition(requestId, 'failed', 'session-persistence-failed')
      showBubbleText(t('app.bubble.error', { msg: '会话保存失败' }), false)
      return false
    }
    chatContext.addUserMessage(userText, images)
    syncContextStats()
    addMessage('user', userText, undefined, undefined, images, userMsgId)
    log.trace("chat_store.send_message.trace", `[${_fn}] 用户消息已加入 ChatContext`, { fn: _fn })

    // 为本回合建立回档检查点（记录回合前的视觉状态；改文件工具执行时再按需备份文件）
    let checkpointId: string
    try {
      checkpointId = await chatSessionPort.beginCheckpoint(requestSessionId, userMsgId)
    } catch (error) {
      log.error('chat.session_checkpoint_failed', '会话检查点保存失败', error, { requestId })
      conversationCoordinator.transition(requestId, 'failed', 'session-persistence-failed')
      showBubbleText(t('app.bubble.error', { msg: '会话保存失败' }), false)
      return false
    }

    // ── 准备气泡 ────────────────────────────────────────
    showBubble.value = true
    currentBubbleText.value = ""
    isTyping.value = false
    currentThinking.value = ''
    log.trace("chat_store.send_message.trace", `[${_fn}] 气泡状态: showBubble=true text="" isTyping=false`, { fn: _fn })

    // ── 收集工具定义（含 say 说话工具）────────────────────
    const charStore = useCharacterStore()
    const hasWorkspace = Boolean(chatSessionPort.workspaceGrantId())
    const tools = [...agentService.getToolDefinitions({
      data: charStore.data,
      capabilities: charStore.getRuntimeSnapshot().capabilities,
      hasWorkspace,
    }), SAY_TOOL_DEF]
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

    // AbortSignal 是 ConversationRun 进入 cancelled 的结果，不再作为平行状态源。
    let wasCancelled = false                      // 用户主动取消标记（跳过兜底气泡）

    // ── 工具调用循环 ─────────────────────────────────────
    // 角色通过 say 工具说话；say 出现即视为最终回复并终止循环。
    // 仅有动作工具（无 say）则继续下一轮，让模型在动作后把话说出来。
    // 循环何时结束由模型自己决定：只要它持续调用工具（读写文件、切换情绪等）
    // 而不 say，循环就一直继续；MAX_TOOL_TURNS 仅为防失控的安全护栏。
    const toolTurns = MAX_TOOL_TURNS

    /** 把最终可见文本落地：写气泡、入 UI 历史。 */
    const commitAssistantMessage = async (
      display: string,
      voice: string | undefined,
      source: AssistantMessageSource,
      playbackText?: string,
    ): Promise<string | null> => {
      // 已取消：翻译兜底期间被用户中止时，不交付、不落盘、不播报
      if (conversationRun.signal.aborted) return null
      conversationCoordinator.transition(requestId, 'finalizing')
      currentBubbleText.value = display
      isTyping.value = false
      const committed = await assistantMessageCoordinator.commit({
        requestId,
        sessionId: requestSessionId,
        display,
        thinking: currentThinking.value || undefined,
        voice,
        source,
        playbackText,
      })
      const messageId = committed?.messageId ?? null
      if (!messageId) return null
      deliveredFinal = true
      return messageId
    }

    /** 把最终台词落地：写气泡、入 UI 历史、触发 TTS */
    const deliver = async (source: AssistantMessageSource, voice: string, display: string) => {
      const messageId = await commitAssistantMessage(display, voice, source, voice)
      if (!messageId) return
      // 气泡立即可见；TTS 订阅已提交事件，不属于 Run 完成条件。
      ttsRequested = true
    }

    /**
     * 可见文本已流式显示后，在后台继续完成语音清洗、历史回填和 TTS。
     * 这样语音模型尚未返回时，输入框可以立即解锁。
     */
    const finalizeVoiceInBackground = (
      messageId: string,
      raw: { voice?: string; display?: string },
      voiceLang: string,
      displayLang: string,
      translate: TranslateFn,
      displayPreview: string,
    ) => {
      const sessionId = requestSessionId
      const voiceStartedAt = performance.now()
      let playbackStarted = false
      const completeBeforePlayback = (status: 'cancelled' | 'failed', reason: string) => {
        const context = {
          requestId,
          status,
          reason,
          durationMs: Math.round(performance.now() - voiceStartedAt),
        }
        if (status === 'failed') log.warn('tts.playback_completed', 'TTS 播放结束', undefined, context)
        else log.info('tts.playback_completed', 'TTS 播放结束', context)
      }
      ttsRequested = true
      backgroundVoiceRun = conversationRun
      void (async () => {
        try {
          const { voice, display } = await resolveSayContent(raw, voiceLang, displayLang, translate)
          if (conversationRun.signal.aborted) {
            completeBeforePlayback('cancelled', 'voice_preparation_cancelled')
            return
          }
          if (chatSessionPort.currentSessionId() !== sessionId) {
            completeBeforePlayback('cancelled', 'session_changed')
            return
          }
          log.sensitiveDebug("chat_store.say_resolved_sensitive.debug", `[${_fn}] say 后台最终文本`, {
            requestId,
            voice,
            display,
          })
          const revised = await assistantMessageCoordinator.revise({
            requestId,
            sessionId,
            messageId,
            voice,
            display: display && display !== displayPreview ? display : undefined,
            playbackText: voice,
          })
          if (!revised) {
            completeBeforePlayback('cancelled', 'message_removed')
            return
          }
          if (currentBubbleText.value === displayPreview && display && display !== displayPreview) {
            currentBubbleText.value = display
          }
          playbackStarted = true
          log.info("chat_store.send_message.info", `[${_fn}] ✓ say 后台语音准备完成 (显示:${display.length}字, TTS:${voice.length}字)`, { display_length: display.length, voice_length: voice.length })
        } catch (err) {
          log.warn("chat_store.send_message.warn", `[${_fn}] ⚠ 后台语音准备失败: ${(err as Error).message}`, err)
          if (!playbackStarted) {
            completeBeforePlayback(
              conversationRun.signal.aborted ? 'cancelled' : 'failed',
              conversationRun.signal.aborted ? 'voice_preparation_cancelled' : (err as Error).message,
            )
          }
        } finally {
          if (backgroundVoiceRun === conversationRun) backgroundVoiceRun = null
        }
      })()
    }

    /**
     * 把一段台词作为合成的 say 工具调用写入 AI 上下文。
     * 用于兜底路径（模型没调 say）：使实时上下文与会话恢复重建的范式保持一致——
     * 助手回合始终表现为 say 调用，避免“纯文本回合”污染范式、诱导模型后续不再调工具。
     */
    const commitSyntheticSay = (voice: string, display: string) => {
      // 已取消：不污染上下文
      if (conversationRun.signal.aborted) return
      const sayId = `say_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      conversationCoordinator.appendSyntheticToolExchange(requestId, {
        id: sayId,
        type: 'function',
        function: { name: SAY_TOOL_NAME, arguments: JSON.stringify({ voice, display }) },
      }, '已说出')
    }

    const toolExecutionCoordinator = new ToolExecutionCoordinator({
      approvalGateway,
      policy: toolExecutionPolicy,
      execute: tc => agentService.execute(tc),
      checkpoint: async path => {
        await chatSessionPort.backupFile(requestSessionId, checkpointId, path)
        await chatSessionPort.markCheckpointFiles(requestSessionId, checkpointId)
      },
      onCheckpointError: (error, path) => {
        log.warn('chat_store.tool_checkpoint_failed', `文件备份失败（继续执行）: ${path}`, error)
      },
      onSessionApproval: () => {
        autoExecSession.value = true
        log.info('chat_store.file_approval_session', '本会话自动允许后续文件操作')
      },
    })
    const executeWithPolicy = (tc: ToolCall): Promise<ToolResult> => toolExecutionCoordinator.execute(tc, {
      signal: conversationRun.signal,
      sessionApproval: autoExecSession.value,
      hasWorkspace: Boolean(chatSessionPort.workspaceGrantId()),
    })

    /** Execute native and text-fallback calls through the same normalized batch path. */
    const executeActionBatch = async (batch: ToolCallBatch) => {
      if (batch.actions.length > 0) conversationCoordinator.transition(requestId, 'executing-tools')
      const toolImages: ImageAttachment[] = []
      const toolTimers = new Map<string, ReturnType<typeof debugTimer>>()
      const result = await executeToolCallBatch(batch.actions, executeWithPolicy, {
        onStart: (invocation, index, count) => {
          const { protocolCall, parseError } = invocation
          toolCallCount++
          toolTimers.set(protocolCall.id, debugTimer(`${_fn} tool#${index} turn#${turnsUsed - 1}`))
          beginActivity(protocolCall.id, protocolCall.function.name || '?')
          log.info('chat_store.tool_started', `执行工具[${index + 1}/${count}]: ${protocolCall.function.name || '?'}`, {
            requestId,
            turn: turnsUsed - 1,
            toolCallId: protocolCall.id,
            toolName: protocolCall.function.name || '?',
            source: batch.source,
          })
          if (parseError) {
            log.error('chat_store.tool_arguments_invalid', `工具参数 JSON 解析失败: ${parseError.message}`, new Error(parseError.message), {
              requestId,
              turn: turnsUsed - 1,
              toolCallId: protocolCall.id,
              toolName: protocolCall.function.name || '?',
              source: batch.source,
            })
          }
        },
        onResult: async ({ invocation, result: toolResult }) => {
          const { protocolCall } = invocation
          if (collectToolImages(toolResult, toolImages)) {
            toolResult.content += `\n部分图片未附加：单轮最多 ${MAX_IMAGE_COUNT} 张且总计不超过 ${Math.floor(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)}MB。`
          }
          toolTimers.get(protocolCall.id)?.stop()
          endActivity(protocolCall.id, resultStatus(toolResult))
          log.sensitiveDebug('chat_store.tool_result_sensitive.debug', '工具执行结果', {
            requestId,
            turn: turnsUsed - 1,
            tool_name: protocolCall.function.name || '?',
            source: batch.source,
            tool_result_content: (toolResult.content || '').slice(0, 200),
          })
          await conversationCoordinator.commitToolResult(requestId, {
            sessionId: requestSessionId,
            callId: protocolCall.id,
            content: toolResult.content,
            status: isToolSkipped(toolResult) ? 'rejected' : isToolError(toolResult) ? 'failed' : 'succeeded',
            code: toolResult.code,
          })
        },
      })
      toolFailureCount += result.failureCount
      return {
        toolImages,
        actionBatchFailed: result.failureCount > 0,
        actionBatchNeedsFollowup: result.needsFollowup,
      }
    }

    log.trace("chat_store.send_message.trace", `[${_fn}] 工具循环开始 安全上限=${toolTurns} 轮 (model=${config.model})`, { fn: _fn, tool_turns: toolTurns, config_model: config.model })
    const loopResult = await conversationCoordinator.runTurns(requestId, toolTurns, async turn => {
      turnsUsed = turn + 1
      log.trace("chat_store.send_message.trace", `[${_fn}] ——— 第 ${turn + 1}/${toolTurns} 轮 ———`, { fn: _fn, turn: turn + 1, tool_turns: toolTurns })
      const turnTimer = debugTimer(`${_fn} turn#${turn}`)

        const streamDecoder = new ModelStreamDecoder()
        const chatTimer = debugTimer(`${_fn} chatOnce turn#${turn}`)
        log.trace("chat_store.send_message.trace", `[${_fn}] 第${turn}轮 chat() 发起请求...`, { fn: _fn, turn: turn })

        const renderStreamText = (text: string) => {
          if (conversationRun.signal.aborted) return
          if (currentBubbleText.value !== text) currentBubbleText.value = text
          isTyping.value = Boolean(text)
        }

        // 流协议解析由 ModelStreamDecoder 负责；Store 只投影解码结果。
        const streamCallbacks = {
          onChunk: (delta: string) => {
            const decoded = streamDecoder.pushContent(delta)
            currentThinking.value = decoded.thinking
            renderStreamText(decoded.visibleText)
          },
          onToolCallDelta: (calls: ToolCallData[]) => {
            const sayCall = calls.find(call => call.function?.name === SAY_TOOL_NAME)
            if (!sayCall) return
            const partial = extractPartialSayArgs(sayCall.function.arguments || '')
            const { voiceLang, displayLang } = getLangs()
            const visible = partial.display?.trim()
              || (voiceLang === displayLang ? partial.voice?.trim() : '')
            if (visible) renderStreamText(visible)
          },
          onThinking: (t: string) => {
            currentThinking.value = streamDecoder.pushThinking(t).thinking
            log.trace("chat_store.send_message.trace", `[${_fn}] onThinking 收到 ${t.length} 字符，累积 ${currentThinking.value.length} 字符`, { fn: _fn, t_length: t.length, current_thinking_value: currentThinking.value.length })
          },
        }

        const requestMessages = chatContext.getMessages(tools)
        if (!hasWorkspace) {
          requestMessages.push({
            role: 'system',
            content: '当前会话尚未授权工作区，文件与命令工具不可用。若任务需要访问文件，请明确提示用户点击界面下方的「工作区」按钮选择目录。',
          })
        }
        syncContextStats()
        modelCallCount++
        const result = await chatOnce(
          requestMessages,
          tools,
          conversationRun.signal,
          streamCallbacks,
          { requestId, turn },
        )
        chatTimer.stop()
        if (conversationRun.signal.aborted) {
          const cancelled = new Error('Conversation run cancelled')
          cancelled.name = 'AbortError'
          throw cancelled
        }

        const interpreted = interpretModelTurn(result, streamDecoder.snapshot(), {
          requestId,
          turn,
          sayToolName: SAY_TOOL_NAME,
          extractTextToolCalls: text => agentService.extractTextToolCalls(text),
          stripTextToolCalls: text => agentService.stripTextToolCalls(text),
        })

        if (interpreted.type === 'empty') {
          log.warn("chat_store.send_message.warn", `[${_fn}] 第${turn}轮 ⚠ AI 返回空内容`, undefined, { fn: _fn, turn })
          turnTimer.stop('empty — break')
          return 'complete'
        }

        if (interpreted.type === 'final-text') {
          fallbackUsed = true
          const visibleText = interpreted.text
          log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 AI 纯文本回复(未走 say), 长度=${visibleText.length}`, { fn: _fn, turn, final_text_length: visibleText.length })
          log.sensitiveDebug("chat_store.send_message_sensitive.debug", `[${_fn}] AI 回复片段`, { fn: _fn, final_text_slice: visibleText.slice(0, 200) })
          const { voiceLang, displayLang, persona } = getLangs()
          const translate: TranslateFn = (txt, target, opts) =>
            translateText(txt, target, {
              persona,
              signal: conversationRun.signal,
              ttsSafe: opts?.ttsSafe,
              requestId,
              turn,
            })
          currentBubbleText.value = visibleText
          isTyping.value = true
          const { voice, display } = await resolveContentFallback(visibleText, voiceLang, displayLang, translate)
          commitSyntheticSay(voice, display)
          await deliver('text-fallback', voice, display)
          log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ✓ 纯正文兜底完成 (显示:${display.length}字, TTS:${voice.length}字)`, { fn: _fn, turn, display_length: display.length, voice_length: voice.length })
          turnTimer.stop('text — break')
          return 'complete'
        }

        const { batch } = interpreted
        const { sayCall } = batch
        log.info("chat_store.send_message.info", `[${_fn}] 第${turn}轮 ★ 工具调用: ${batch.protocolCalls.length} 个 (source=${batch.source}, say=${sayCall ? '有' : '无'}, 动作=${batch.actions.length})`, { fn: _fn, turn, source: batch.source, result_calls: batch.protocolCalls.length, say_call: sayCall ? '有' : '无', action_calls_length: batch.actions.length })
        if (sayCall) {
          const rawForLog = parseSayArgs(sayCall.function.arguments || '{}')
          log.sensitiveDebug("chat_store.say_sensitive.debug", `[${_fn}] 第${turn}轮 say 原始文本`, {
            requestId,
            turn,
            voice: rawForLog.voice ?? '',
            display: rawForLog.display ?? '',
          })
        }

        currentBubbleText.value = ""
        await conversationCoordinator.commitToolCalls(requestId, {
          sessionId: requestSessionId,
          stepId: `${requestId}:${turn}`,
          calls: batch.protocolCalls,
          visibleText: batch.assistantText,
        })
        const { toolImages, actionBatchFailed, actionBatchNeedsFollowup } = await executeActionBatch(batch)

        // say 不能抢在同批动作的图片、失败或拒绝结果之前成为最终答复。
        if (sayCall && (toolImages.length || actionBatchNeedsFollowup)) {
          isTyping.value = false
          const reason = actionBatchFailed
            ? '未说出：需要先读取并处理刚才的工具失败结果，再生成最终答复。'
            : toolImages.length
              ? '未说出：需要先观察刚读取的图片，再生成最终答复。'
              : '未说出：需要先读取并处理用户跳过该操作的结果，再生成最终答复。'
          await conversationCoordinator.commitToolResult(requestId, {
            sessionId: requestSessionId,
            callId: sayCall.id,
            content: reason,
            status: 'rejected',
            code: 'SAY_DEFERRED',
          })
          conversationCoordinator.appendToolImages(
            requestId,
            batch.actions.map(action => action.protocolCall.id).join(', '),
            toolImages,
          )
          turnTimer.stop(actionBatchFailed ? 'tool-failed — continue' : 'tool-followup — continue')
          return 'continue'
        }

        if (sayCall) {
          const { voiceLang, displayLang, persona } = getLangs()
          const translate: TranslateFn = (txt, target, opts) =>
            translateText(txt, target, {
              persona,
              signal: conversationRun.signal,
              ttsSafe: opts?.ttsSafe,
              requestId,
              turn,
            })
          const raw = parseSayArgs(sayCall.function.arguments || '{}')
          const displayPreview = raw.display?.trim() || (voiceLang === displayLang ? raw.voice?.trim() : '')
          if (displayPreview) {
            currentBubbleText.value = displayPreview
            isTyping.value = false
          }
          await conversationCoordinator.commitToolResult(requestId, {
            sessionId: requestSessionId,
            callId: sayCall.id,
            content: '已说出',
            status: 'succeeded',
          })
          if (displayPreview) {
            const messageId = await commitAssistantMessage(displayPreview, raw.voice, 'say')
            if (messageId) finalizeVoiceInBackground(messageId, raw, voiceLang, displayLang, translate, displayPreview)
          } else {
            const { voice, display } = await resolveSayContent(raw, voiceLang, displayLang, translate)
            if (voice || display) await deliver('say', voice, display)
            else log.warn("chat_store.send_message.warn", `[${_fn}] 第${turn}轮 ⚠ say 内容为空`, undefined, { fn: _fn, turn })
          }
          turnTimer.stop('say — break')
          return 'complete'
        }

        if (toolImages.length) {
          conversationCoordinator.appendToolImages(
            requestId,
            batch.actions.map(action => action.protocolCall.id).join(', '),
            toolImages,
          )
        }
        isTyping.value = false
        if (batch.assistantText?.trim()) {
          log.debug("chat_store.send_message.debug", `[${_fn}] 第${turn}轮忽略工具执行前正文并继续`, {
            fn: _fn,
            turn,
            pre_tool_text_length: batch.assistantText.length,
          })
        }
        turnTimer.stop('actions — continue')
        return 'continue'
    })
    turnsUsed = loopResult.turnsUsed
    if (loopResult.status === 'cancelled') {
      wasCancelled = true
      log.info("chat_store.send_message.info", `[${_fn}] ⏹ 请求被取消`, { fn: _fn, turns_used: turnsUsed })
    } else if (loopResult.status === 'failed') {
      const errMsg = loopResult.error instanceof Error ? loopResult.error.message : String(loopResult.error)
      log.error("chat.turn_failed", "对话执行失败", loopResult.error, {
        operation: _fn,
        turn: Math.max(0, turnsUsed - 1),
        requestId,
      })
      failed = true
      showBubbleText(t('app.bubble.error', { msg: errMsg }), false)
    }

    // ── 循环结束 ────────────────────────────────────────
    // 被取消/取代时仍写统一完成事件，但不能覆盖后来请求的 UI 状态。
    // 投影写权限由 Coordinator 按 run id + 非终态判断，不再比较 AbortController 身份。
    const ownsRequestState = conversationCoordinator.mayProject(requestId)
    if (!ownsRequestState) {
      wasCancelled = true
      terminalReason = 'cancelled'
      log.info("chat.request_cancelled", "对话请求被替代或取消", { requestId })
      log.info("chat_store.send_message.info", `[${_fn}] 本次请求已被取消或被新请求取代，仅记录终态`, { fn: _fn })
    }

    if (wasCancelled) {
      // 用户主动取消：不展示兜底气泡
      log.info("chat_store.send_message.info", `[${_fn}] 已取消，跳过兜底提示`, { fn: _fn })
    } else if (failed) {
      terminalReason = 'error'
      log.info("chat_store.send_message.info", `[${_fn}] 请求失败，保留具体错误提示`, { fn: _fn })
    } else if (!deliveredFinal) {
      // 模型始终未调 say 就触达安全上限（异常：通常是模型陷入工具死循环），展示兜底提示
      terminalReason = turnsUsed >= toolTurns ? 'tool_turn_limit' : 'empty_response'
      log.warn("chat_store.send_message.warn", `[${_fn}] ⚠ 请求结束但没有可交付的最终回复`, undefined, { fn: _fn, terminal_reason: terminalReason, turns_used: turnsUsed })
      if (ownsRequestState) showBubbleText(t('app.bubble.done'), false)
    } else {
      log.debug("chat_store.send_message.debug", `[${_fn}] 循环结束，气泡已设置 (${currentBubbleText.value.length}字)`, { fn: _fn, current_bubble_text_value: currentBubbleText.value.length })
    }

    if (ownsRequestState) {
      // 工具活动列表：本次有调用则保留一会儿供用户回看，再淡出；无调用则立即隐藏。
      // 被新请求取代的旧任务不得修改新任务的共享活动状态。
      if (toolActivities.value.length > 0) {
        if (toolHideTimer !== null) clearTimeout(toolHideTimer)
        toolHideTimer = setTimeout(() => { showToolActivity.value = false; toolHideTimer = null }, 5000)
      } else {
        showToolActivity.value = false
      }
    }

    // 完成状态分级：取消 > 硬错误 > 有工具失败但仍有输出 > 全部成功
    const completionStatus: 'success' | 'partial_success' | 'failed' | 'cancelled' =
      wasCancelled ? 'cancelled'
      : failed || !deliveredFinal ? 'failed'
      : toolFailureCount > 0 ? 'partial_success'
      : 'success'
    if (ownsRequestState) {
      if (completionStatus === 'failed') {
        conversationCoordinator.transition(requestId, 'failed', terminalReason)
      } else {
        if (conversationCoordinator.current()?.state !== 'finalizing') {
          conversationCoordinator.transition(requestId, 'finalizing')
        }
        conversationCoordinator.transition(requestId, 'completed', terminalReason)
      }
    }
    const completedContext = {
      requestId,
      completionStatus,
      failed: completionStatus === 'failed',
      cancelled: wasCancelled,
      durationMs: Math.round(performance.now() - requestStartedAt),
      turnsUsed,
      toolTurnLimit: toolTurns,
      toolDefinitionCount: tools.length,
      toolDefinitionTokens: contextStats.value.toolDefinitionTokens,
      modelCallCount,
      toolCallCount,
      toolFailureCount,
      fallbackUsed,
      ttsStatus: ttsRequested ? 'pending' : 'not_requested',
      terminalReason: completionStatus === 'cancelled' ? 'cancelled' : failed ? 'error' : terminalReason,
    }
    if (completionStatus === 'failed') {
      log.error('chat.request_completed', '对话请求结束', new Error('对话请求失败'), completedContext)
    } else {
      log.info('chat.request_completed', '对话请求结束', completedContext)
    }

    _timer.stop()
    log.trace("chat_store.send_message.trace", `[${_fn}] ◀ (正常结束)`, { fn: _fn })
    return completionStatus !== 'failed'
  }

  /** 触发角色 TTS 语音播报 */
  let lastTtsText = ''
  async function triggerTts(text: string, requestId?: string): Promise<TtsPlaybackStatus> {
    const _fn = 'triggerTts'
    const startedAt = performance.now()
    let firstAudioReported = false
    const complete = (status: TtsPlaybackStatus, reason?: string): TtsPlaybackStatus => {
      const context = { requestId, status, reason, durationMs: Math.round(performance.now() - startedAt) }
      if (status === 'failed') log.warn('tts.playback_completed', 'TTS 播放结束', undefined, context)
      else log.info('tts.playback_completed', 'TTS 播放结束', context)
      return status
    }
    log.trace("chat_store.trigger_tts.trace", `[${_fn}] ▶ 播报文本(${text.length}字)`, { fn: _fn, text_length: text.length })

    if (!text.trim()) return complete('skipped', 'empty_text')

    // 去重：连续播报相同文本跳过
    if (text === lastTtsText) {
      log.trace("chat_store.trigger_tts.trace", `[${_fn}] 跳过重复播报: text === lastTtsText`, { fn: _fn })
      return complete('skipped', 'duplicate')
    }

    try {
      const charStore = useCharacterStore()
      const provider = getTtsProvider()
      const voiceId = charStore.data?.voice

      if (!isTtsEnabled()) return complete('skipped', 'disabled')
      if (provider === 'none') {
        log.trace("chat_store.trigger_tts.trace", `[${_fn}] TTS 已禁用（提供者为 none），跳过`, { fn: _fn })
        return complete('skipped', 'provider_none')
      }
      // CosyVoice 需要 voiceId；GPT-SoVITS 不需要
      if (provider === 'cosyvoice' && !voiceId) {
        log.trace("chat_store.trigger_tts.trace", `[${_fn}] 无 voiceId 配置，跳过 TTS`, { fn: _fn })
        return complete('skipped', 'missing_voice_id')
      }
      const voiceLang = charStore.data?.voiceLanguage || '?'
      const ttsTimer = debugTimer(_fn)
      log.sensitiveDebug('tts.voice_text_sensitive.debug', '送入 TTS 的语音文本', {
        requestId,
        provider,
        voice_lang: voiceLang,
        voice_text: text,
      })
      const result = await speakTextStreaming(text, voiceId || '', {
        onSynthesisStart: () => {
          log.info('tts.synthesis_started', 'TTS 合成开始', { requestId, provider, textLength: text.length, voiceLang })
          log.info("chat_store.trigger_tts.info", `[${_fn}] 开始 TTS 播报: lang=${voiceLang} text=${text.length}字`, { fn: _fn, has_voice_id: Boolean(voiceId), voice_lang: voiceLang, text_length: text.length })
        },
        onFirstAudio: () => {
          if (firstAudioReported) return
          firstAudioReported = true
          log.info('tts.first_audio', 'TTS 首段音频开始播放', {
            requestId,
            provider,
            latencyMs: Math.round(performance.now() - startedAt),
          })
        },
      })
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
      return complete(result.status, result.reason)
    } catch (err) {
      log.warn("chat_store.trigger_tts.warn", `[${_fn}] ⚠ TTS 播报异常 (静默): ${(err as Error).message}`, err, { fn: _fn })
      return complete('failed', (err as Error).message)
    } finally {
      log.trace("chat_store.trigger_tts.trace", `[${_fn}] ◀`, { fn: _fn })
    }
  }

  function cancelResponse() {
    const _fn = 'cancelResponse'
    log.trace("chat_store.cancel_response.trace", `[${_fn}] ▶`, { fn: _fn })
    log.debug("chat_store.cancel_response.debug", `[${_fn}] 取消前状态: run=${conversationRunState.value}`, { fn: _fn, run_state: conversationRunState.value })

    // 兜底拒绝待确认的操作，解除工具循环的 await
    rejectPendingApproval()
    conversationCoordinator.cancelActive('user-cancelled')
    cancelBackgroundVoicePreparation()

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
    messageId?: string,
  ): string {
    const _fn = 'addMessage'
    const id = messageId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const msgLen = text.length
    const thinkLen = thinking?.length || 0

    log.trace("chat_store.add_message.trace", `[${_fn}] ▶ role=${role} text=${msgLen}字 thinking=${thinkLen}字`, { fn: _fn, role: role, msg_len: msgLen, think_len: thinkLen })
    log.debug("chat_store.add_message.debug", `[${_fn}] 消息ID=${id} role=${role} length=${text.length}`, { fn: _fn, id, role, text_length: text.length })
    log.sensitiveDebug("chat_store.message_sensitive.debug", `[${_fn}] 消息片段`, { fn: _fn, id, role, text_slice: text.slice(0, 60) })

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

    log.trace("chat_store.add_message.trace", `[${_fn}] ◀`, { fn: _fn })
    return id
  }

  function clearMessages() {
    const _fn = 'clearMessages'
    const prevCount = messages.value.length
    log.trace("chat_store.clear_messages.trace", `[${_fn}] ▶ (当前消息数=${prevCount})`, { fn: _fn, prev_count: prevCount })

    // 先取消正在进行中的 AI 请求和后台语音，避免其回调写入已被清空的上下文。
    conversationCoordinator.cancelActive('messages-cleared')
    cancelBackgroundVoicePreparation()
    cancelSpeak()
    lastTtsText = ''
    rejectPendingApproval()
    autoExecSession.value = false
    hideBubble()
    currentThinking.value = ''

    if (prevCount > 0) {
      const last = messages.value[prevCount - 1]
      log.debug("chat_store.clear_messages.debug", `[${_fn}] 最后一条消息: role=${last?.role || '?'} length=${last?.text.length || 0}`, { fn: _fn, role: last?.role || '?', text_length: last?.text.length || 0 })
      log.sensitiveDebug("chat_store.cleared_message_sensitive.debug", `[${_fn}] 被清空的末条消息片段`, { fn: _fn, text_slice: (last?.text || '').slice(0, 50) })
    }

    messages.value = []
    log.trace("chat_store.clear_messages.trace", `[${_fn}] messages → []`, { fn: _fn })

    chatContext = createChatContext()
    currentPersona = null
    syncContextStats()
    log.trace("chat_store.clear_messages.trace", `[${_fn}] chatContext → createChatContext()`, { fn: _fn })

    // 会话事实与检查点由 Session Aggregate 一次性清空。
    void chatSessionPort.clearConversation(chatSessionPort.currentSessionId())
    log.info("chat_store.clear_messages.info", `[${_fn}] ✓ 已清空 ${prevCount} 条聊天记录`, { fn: _fn, prev_count: prevCount })
    log.trace("chat_store.clear_messages.trace", `[${_fn}] ◀`, { fn: _fn })
  }

  function resetContext() {
    const _fn = 'resetContext'
    log.trace("chat_store.reset_context.trace", `[${_fn}] ▶`, { fn: _fn })
    cancelBackgroundVoicePreparation()
    cancelSpeak()
    lastTtsText = ''
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

    // 切换、回档或恢复历史时，旧回复的后台语音不得继续写回或播放。
    cancelBackgroundVoicePreparation()
    cancelSpeak()
    lastTtsText = ''

    // 统计消息组成
    const userCount = msgs.filter(m => m.role === 'user').length
    const asstCount = msgs.filter(m => m.role === 'assistant').length
    log.debug("chat_store.load_messages.debug", `[${_fn}] 消息组成: user=${userCount} assistant=${asstCount} 总计=${msgs.length}`, { fn: _fn, user_count: userCount, asst_count: asstCount, msgs_length: msgs.length })

    if (msgs.length > 0) {
      log.debug("chat_store.load_messages.debug", `[${_fn}] 首末消息: first=${msgs[0].role}/${msgs[0].text.length} last=${msgs[msgs.length - 1].role}/${msgs[msgs.length - 1].text.length}`, { fn: _fn, first_role: msgs[0].role, first_length: msgs[0].text.length, last_role: msgs[msgs.length - 1].role, last_length: msgs[msgs.length - 1].text.length })
      log.sensitiveDebug("chat_store.loaded_messages_sensitive.debug", `[${_fn}] 已加载消息片段`, { fn: _fn, first_text: msgs[0].text.slice(0, 50), last_text: msgs[msgs.length - 1].text.slice(0, 50) })
    }

    messages.value = [...msgs]
    log.trace("chat_store.load_messages.trace", `[${_fn}] messages 已替换（当前 ${messages.value.length} 条）`, { fn: _fn, messages_value: messages.value.length })

    // 重置气泡和 AI 上下文
    conversationCoordinator.cancelActive('session-changed')
    hideBubble()
    showInput.value = false
    currentThinking.value = ''
    // 切换/恢复会话：解除待确认项，并重置「本会话自动允许」
    rejectPendingApproval()
    autoExecSession.value = false
    log.trace("chat_store.load_messages.trace", `[${_fn}] 气泡状态已重置: hideBubble showInput=false thinking=""`, { fn: _fn })

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
        log.trace("chat_store.load_messages.trace", `[${_fn}]   [${i + 1}/${msgs.length}] user → context (${msg.text.length}字)`, { fn: _fn, i: i + 1, msgs_length: msgs.length, text_length: msg.text.length })
        log.sensitiveDebug("chat_store.replay_message_sensitive.debug", '重放用户消息片段', { index: i, text_slice: msg.text.slice(0, 40) })
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
        log.trace("chat_store.load_messages.trace", `[${_fn}]   [${i + 1}/${msgs.length}] assistant → say 调用重建 (${msg.text.length}字)`, { fn: _fn, i: i + 1, msgs_length: msgs.length, text_length: msg.text.length })
        log.sensitiveDebug("chat_store.replay_message_sensitive.debug", '重放助手消息片段', { index: i, text_slice: msg.text.slice(0, 40) })
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
      log.debug("chat_store.load_messages.debug", `[${_fn}] ✓ 显示最后AI消息: length=${lastAssistant.text.length} thinking=${lastAssistant.thinking ? `${lastAssistant.thinking.length}字` : '无'}`, { fn: _fn, last_assistant_length: lastAssistant.text.length, last_assistant_thinking: lastAssistant.thinking ? `${lastAssistant.thinking.length}字` : '无' })
      log.sensitiveDebug("chat_store.last_message_sensitive.debug", `[${_fn}] 最后AI消息片段`, { fn: _fn, text_slice: lastAssistant.text.slice(0, 40) })
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
    log.debug("chat_store.set_system_prompt.debug", `[${_fn}] prompt长度=${prompt?.length || 0}`, { fn: _fn, prompt_length: prompt?.length || 0 })
    log.sensitiveDebug("chat_store.system_prompt_sensitive.debug", `[${_fn}] prompt片段`, { fn: _fn, prompt_slice: (prompt || '').slice(0, 50) })
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
    const tools = [
      ...agentService.getToolDefinitions({
        data: useCharacterStore().data,
        capabilities: useCharacterStore().getRuntimeSnapshot().capabilities,
        hasWorkspace: Boolean(chatSessionPort.workspaceGrantId()),
      }),
      SAY_TOOL_DEF,
    ] as ToolDefinition[]
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
        runState: conversationRunState.value,
        processing: isProcessing.value,
        usingTools: isUsingTools.value,
        activities: toolActivities.value.map(activity => ({ ...activity })),
        pendingConfirmation: pendingApproval.value
          ? {
            toolName: pendingApproval.value.toolName,
            path: pendingApproval.value.kind === 'screen-capture'
              ? pendingApproval.value.target
              : pendingApproval.value.kind === 'command'
                ? pendingApproval.value.summary
                : pendingApproval.value.path,
          }
          : null,
        autoExecSession: autoExecSession.value,
      },
    }
  }

  function showBubbleText(text: string, typing: boolean = true) {
    const _fn = 'showBubbleText'
    log.trace("chat_store.show_bubble_text.trace", `[${_fn}] text=${text.length}字 typing=${typing}`, { fn: _fn, text_length: text.length, typing: typing })
    log.sensitiveDebug("chat_store.bubble_text_sensitive.debug", '气泡文本片段', { text_slice: text.slice(0, 50) })
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
    conversationRunState,
    isUsingTools,
    toolActivities,
    showToolActivity,
    pendingApproval,
    autoExecSession,
    resolveApproval,
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
