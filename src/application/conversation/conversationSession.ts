/**
 * 对话回合的编排归属。
 *
 * 一次对话回合的全部编排都在这个模块里：守卫、用户消息事务、检查点、工具清单装配、
 * 回合循环、say 合成与提交、后台语音准备、终态分类与遥测。对外只有一条缝 ——
 * send / cancel / projection / subscribe；其余全部是构造时注入的端口。
 *
 * 无框架依赖：不得 import Vue、Pinia 或 Tauri API，由架构边界测试约束。
 * 缺装配必须显式失败：构造时逐个校验端口，少一个就抛错，而不是静默空转。
 */
import { MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES } from '../../ai/images'
import { MAX_TOOL_TURNS } from '../../ai/modelCapabilities'
import { SAY_TOOL_DEF, SAY_TOOL_NAME } from '../../agent/tools/say'
import { createLogger } from '../../utils/logger'
import { AssistantMessageCoordinator } from './assistantMessageCoordinator'
import { ConversationCoordinator, isConversationRunActive, type ConversationRun } from './conversationRun'
import { ModelStreamDecoder, extractPartialSayArgs, parseSayArgs } from './modelStreamDecoder'
import { interpretModelTurn } from './modelTurnInterpreter'
import { executeToolCallBatch, type ProtocolToolCall, type ToolCallBatch } from './toolCallBatch'
import { resolveContentFallback, resolveSayContent, type TranslateFn } from './roundText'
import { collectToolImages, isToolError, isToolSkipped, resultStatus, toolImageLimitNotice } from './toolOutcome'

import type { AssistantMessageEvent } from './assistantMessageCoordinator'
import type { ContextStats } from '../../ai/context'
import type {
  ChatMessage as ConversationModelMessage,
  ImageAttachment,
  ToolCallData,
} from '../../ai/types'
import type { ToolCall, ToolDefinition, ToolResult } from '../../agent/types'
import type { CharacterToolContext } from '../../agent/registry'
import type { CharacterData } from '../../character/loader'
import type { ConversationImage } from '../../domain/conversation/events'
import type { CharacterCapabilities } from '../character/characterRuntime'
import type { ToolExecutionCoordinator } from '../tools/toolExecutionCoordinator'
import type { ChatSessionPort } from './chatSessionPort'
import type { ConversationRunState, ConversationToolTurnPorts, ConversationTurnDirective } from './conversationRun'
import type { RawModelTurn } from './modelTurnInterpreter'

const log = createLogger('ConversationSession')

// ─── 对外缝 ────────────────────────────────────────────

/** 一次用户输入。文本为空且无图片时由空消息守卫拒绝。 */
export interface ConversationInput {
  text: string
  images: readonly ConversationImage[]
}

/** 失败原因。守卫拒绝与执行期失败都在这里区分，供界面提示与遥测使用。 */
export type ConversationSendFailureReason =
  | 'reentrant'
  | 'empty-input'
  | 'network-unavailable'
  | 'invalid-configuration'
  | 'session-persistence-failed'
  | 'model-failure'
  | 'empty-response'

/**
 * 一次 send 的结果。
 *
 * 业务失败是结果变体，不抛异常：
 * - `success` —— 已交付最终回复；`partial` 表示有工具失败但仍交付了回复。
 * - `cancelled` —— 被用户、会话切换或新回合中止；`reason` 即回合计状态机记录的取消来源。
 * - `failed` —— 守卫拒绝或执行期失败。
 * - `turn-limit` —— 触达模型轮次上限仍未交付（通常是模型陷入工具死循环）。
 *
 * `requestId` 在守卫于回合开始前拒绝时为 null。
 */
export type SendResult =
  | { status: 'success'; requestId: string | null; turnsUsed: number; partial: boolean; fallbackUsed: boolean }
  | { status: 'cancelled'; requestId: string | null; turnsUsed: number; reason: string }
  | { status: 'failed'; requestId: string | null; turnsUsed: number; reason: ConversationSendFailureReason; error?: string }
  | { status: 'turn-limit'; requestId: string | null; turnsUsed: number }

/** 回合派生的一条工具活动（临时态，不持久化）。 */
export interface ConversationToolActivity {
  /** 工具调用 id（动作工具用协议 id，文本兜底用其生成的 id）。 */
  id: string
  /** 原始工具名，如 'read_file'、'set_character_emotion'。 */
  name: string
  status: 'running' | 'done' | 'error' | 'skipped'
}

/**
 * 由回合派生的界面状态：订阅者拿到的唯一只读视图。
 *
 * 纯界面开关（输入框开合、气泡显隐）不在这里，仍由展示层自己持有。
 * 待批准请求也不在这里 —— 它有 ApprovalGateway 这条专属的投影来源。
 */
export interface ConversationProjection {
  /** 当前回合 id；没有进行中的回合时为 null。 */
  runId: string | null
  /** 回合计状态。 */
  runState: ConversationRunState
  /** 回合计状态机的 revision，供订阅者判断投影是否真的前进过。 */
  revision: number
  /** 气泡文本（含流式中间态）。 */
  bubbleText: string
  /** 气泡正在追加文本。 */
  typing: boolean
  /** 思考过程文本。 */
  thinking: string
  /** 本回合的工具活动，按发生顺序排列。 */
  toolActivities: readonly ConversationToolActivity[]
  /** 上下文统计。 */
  context: ContextStats
  /**
   * 本会话内已允许自动执行后续文件操作（用户在批准卡上选「本会话允许」产生）。
   *
   * 它是回合内由用户决策产生的策略状态，不是纯界面开关，也不能只留在回合内部：
   * 诊断面板读它（`CurrentContextInspection.runtime.autoExecSession`），而对外只有
   * 投影这一条可观察通道。用户主动停止一次回复不重置；清空对话、切换会话、切换
   * 角色、替换模型上下文都重置。
   */
  autoExecSession: boolean
}

export type ConversationProjectionListener = (projection: ConversationProjection) => void

/**
 * 一条已计入会话事实的界面消息。
 *
 * 界面消息列表不在投影里：它是展示层自己持有的状态（#14 的边界决定）。但它的 id
 * 必须与会话事实一致 —— 语音回填与回档都按 id 寻址 —— 所以「哪条消息以什么内容落库」
 * 这条事实要有一条出口。这条出口只讲事实，由谁维护列表、怎么显示，回合不关心。
 */
export type ConversationMessageEvent =
  | {
    type: 'user-accepted'
    sessionId: string
    messageId: string
    text: string
    images: readonly ConversationImage[]
  }
  | AssistantMessageEvent

export type ConversationMessageListener = (event: ConversationMessageEvent) => void

/**
 * 回合编排的可调参数。
 * 它们不是对外部世界的依赖，因此不进端口集合；缺省值由实现取既有常量
 * （MAX_TOOL_TURNS、MAX_IMAGE_COUNT、MAX_TOTAL_IMAGE_BYTES 都在无框架依赖的模块里）。
 */
export interface ConversationSessionOptions {
  /** 模型调用轮次的安全上限（今日为 MAX_TOOL_TURNS），防止模型陷入永不 say 的工具死循环。 */
  maxToolTurns?: number
  /** 单轮工具输出图片的数量上限（今日为 MAX_IMAGE_COUNT）。 */
  maxImageCount?: number
  /** 单轮工具输出图片的总体积上限，单位字节（今日为 MAX_TOTAL_IMAGE_BYTES）。 */
  maxTotalImageBytes?: number
}

// ─── 注入端口 ──────────────────────────────────────────

/** 模型配置快照；守卫与遥测读它。 */
export interface ConversationModelConfiguration {
  /** 模型、凭据与端点是否齐备。 */
  ready: boolean
  /** 模型标识，仅用于日志与遥测；未配置时为空串。 */
  model: string
}

/** 一次模型调用的入参；回调语义沿用既有流协议。 */
export interface ConversationModelRequest {
  requestId: string
  turn: number
  messages: readonly ConversationModelMessage[]
  tools: readonly ToolDefinition[]
  /** 随回合一起中止。 */
  signal: AbortSignal
  onChunk(chunk: string): void
  onThinking(chunk: string): void
  onToolCallDelta(calls: readonly ToolCallData[]): void
}

/**
 * 模型客户端端口：取代对 AI 模块 `chat()` 的直接调用，
 * 以及其中隐含的配置加载与校验。实现建在既有的请求执行器之上，不新增网络策略。
 */
export interface ConversationModelClient {
  configuration(): ConversationModelConfiguration
  /** 发起一次模型调用，返回已归一化的轮次结果。 */
  call(request: ConversationModelRequest): Promise<RawModelTurn>
}

/** 翻译上下文：绑定本回合的人设、取消信号与遥测关联。 */
export interface ConversationTranslateContext {
  /** 说话者人设，让译文贴合角色语气。 */
  persona?: string
  signal: AbortSignal
  requestId: string
  turn: number
  /** 输出将直接送入 TTS，要求改写为可朗读文本。 */
  ttsSafe?: boolean
}

/**
 * 翻译端口：取代对 `translateText()` 的直接调用。
 * 回合内只构造一处翻译闭包，不再逐路径重复一份。
 */
export interface ConversationTranslator {
  /** 翻译失败由实现回退原文，不向回合抛错。 */
  translate(text: string, targetLang: string, context: ConversationTranslateContext): Promise<string>
}

/** 角色身份快照。 */
export interface ConversationCharacterIdentity {
  id: string
  name: string
}

/** 回合需要的一切角色事实。 */
export interface ConversationCharacterState {
  /** 角色身份；assistant 消息落库时记录。无角色时为 null。 */
  identity: ConversationCharacterIdentity | null
  /** 说话人设（角色名），供翻译使用。 */
  persona?: string
  /** 送入 TTS 的音色；无角色时为空串。 */
  voice: string
  /** TTS 合成语言；实现负责回退到默认值。 */
  voiceLanguage: string
  /** 文本显示语言；实现负责把角色的 textLanguage 归一化为可用的语言代码。 */
  displayLanguage: string
  /** 渲染方式，决定哪些工具对本角色可见。 */
  render: 'illustration' | 'live2d'
  /** 工具清单装配所需的角色数据。 */
  data: CharacterData | null
  /** 工具清单装配所需的能力快照。 */
  capabilities: CharacterCapabilities | null
}

/**
 * 角色人设来源：取代回合内对 Pinia 角色 store 的直接读取。
 * 控制器可能在本轮初始化期间才挂载，故实现每次都现取。
 */
export interface ConversationCharacterSource {
  state(): ConversationCharacterState
}

/**
 * 模型上下文端口：本次请求发给模型的消息，以及回合过程中对它的追加。
 * 追加侧的形状直接复用 ConversationToolTurnPorts 的 modelContext，
 * 使回合可以原样交给 ConversationCoordinator 提交工具回合。
 */
export type ConversationModelContext = ConversationToolTurnPorts['modelContext'] & {
  /** 本次请求要发给模型的消息（已含 system 提示与历史）。 */
  messages(tools: readonly ToolDefinition[]): readonly ConversationModelMessage[]
  /** 提交用户消息，供后续轮次使用。 */
  addUserMessage(text: string, images: readonly ConversationImage[]): void
  /** 当前上下文统计。 */
  stats(): ContextStats
}

/**
 * 工具清单端口：本次请求可用的工具定义，以及文本兜底调用的提取。
 * 与执行流水线分开：清单是纯数据，执行才是外部依赖。
 */
export interface ConversationToolCatalog {
  /** 本次请求的工具定义（含 say）；工作区授权状态决定文件与命令工具是否可见。 */
  definitions(context: CharacterToolContext): ToolDefinition[]
  /** 从模型正文中提取文本形式的工具调用（兜底路径）。 */
  extractTextToolCalls(text: string): ToolCall[]
  /** 从模型正文中移除文本形式的工具调用，得到用户可见文本。 */
  stripTextToolCalls(text: string): string
}

/** 回合为工具流水线提供的钩子：检查点绑定在本回合上。 */
export interface ConversationToolRoundHooks {
  /** 备份本回合检查点涉及的单个文件。 */
  checkpoint(path: string): Promise<void>
  onCheckpointError?(error: unknown, path: string): void
  onSessionApproval?(): void
}

/** 批准待决状态的变化：`true` 表示有请求正在等用户决定。 */
export type ConversationApprovalListener = (pending: boolean) => void

/**
 * 工具执行端口：复用既有的 ToolExecutionCoordinator 与它的策略。
 * 批准网关、执行策略与执行器由组合根持有；检查点回调按回合绑定，故每回合构造一次。
 */
export interface ConversationToolExecutionPort {
  create(round: ConversationToolRoundHooks): ToolExecutionCoordinator
  /**
   * 订阅「是否有请求在等用户批准」，订阅时立刻回调一次当前状态。
   *
   * 只传布尔量：待批准请求的值归 ApprovalGateway.subscribe 那条专属投影来源，
   * 在这里再收一份就是第二份真相。回合只借它把回合计驱动到 awaiting-approval。
   */
  subscribeApproval(listener: ConversationApprovalListener): () => void
}

/** 一次语音播放请求。requestId 只用于遥测关联，寻址由实现自己负责。 */
export interface ConversationVoiceRequest {
  requestId: string
  text: string
  voiceId: string
  voiceLanguage: string
  deduplicate?: boolean
}

/**
 * 语音播放入口：取代对模块级 TTS 编排器单例的直接引用。
 * play 不返回 Promise —— 语音是回复提交之后的独立副作用，不阻塞回合完成。
 */
export interface ConversationVoicePort {
  play(request: ConversationVoiceRequest): void
  /** 中止当前播放；resetDedupe 同时清空去重记录。 */
  cancel(reason: string, resetDedupe?: boolean): void
}

/**
 * id 用途：
 * - `request` —— 一次对话请求的 id（今日为 `crypto.randomUUID()`）。
 * - `user-message` —— 用户消息 id，同时用作本回合的检查点 id（今日为 `${Date.now()}-xxxxxx`）。
 * - `say-synthetic` —— 文本兜底路径合成的 say 调用 id（今日为 `say_fallback_${Date.now()}_xxxx`）。
 */
export type ConversationIdKind = 'request' | 'user-message' | 'say-synthetic'

/** 时钟与 id 生成：取代对 Date.now / performance.now / crypto.randomUUID 的现场调用。 */
export interface ConversationClock {
  /** 墙钟时间（毫秒）；用于事件时间戳与消息 id。 */
  now(): number
  /** 单调时钟读数（毫秒）；两次读数之差即耗时。 */
  monotonic(): number
  /** 按用途生成 id；同一用途的形态由实现保持稳定。 */
  nextId(kind: ConversationIdKind): string
}

/** 在线状态探测：取代对 navigator.onLine 的现场读取。 */
export interface ConversationNetworkProbe {
  isOnline(): boolean
}

/**
 * 文案端口：回合写进界面与用户消息的全部字符串。
 *
 * 回合不能自己 import i18n —— `src/i18n/index.ts` 依赖 vue-i18n，违反 application 层的
 * 框架边界；也不能把文案甩给展示层 —— `imageOnlyPrompt` 会作为用户消息正文持久化，
 * 气泡文案必须在 send() 返回之前就进投影。
 *
 * 方法名与既有 i18n key 一一对应，逐字不变；改名不改文案。
 */
export interface ConversationTexts {
  /** `chat.input.imageOnlyPrompt` —— 只发了图片时的用户消息正文。 */
  imageOnlyPrompt(): string
  /** `app.bubble.networkOff` —— 网络不可用。 */
  networkOff(): string
  /** `app.bubble.apiNotConfigured` —— API 未配置。 */
  apiNotConfigured(): string
  /** `app.bubble.error` —— 回合失败；`msg` 就是模板里的插值参数。 */
  error(msg: string): string
  /** `app.bubble.done` —— 没有可交付回复时的兜底气泡。 */
  done(): string
}

/**
 * 构造 ConversationSession 时注入的全部端口，缺一即构造失败。
 * 装配点是组合根：对象图只在那里构建一次。
 */
export interface ConversationSessionPorts {
  model: ConversationModelClient
  translate: ConversationTranslator
  character: ConversationCharacterSource
  context: ConversationModelContext
  /**
   * 会话事实：复用既有的 ChatSessionPort，不再新增会话边界。
   * 它的 recordToolCalls / recordToolResult 与 ConversationToolTurnPorts 的 session 同形。
   */
  session: ChatSessionPort
  tools: ConversationToolCatalog
  toolExecution: ConversationToolExecutionPort
  voice: ConversationVoicePort
  clock: ConversationClock
  network: ConversationNetworkProbe
  /** 文案：回合写进界面与用户消息的字符串。 */
  texts: ConversationTexts
}

// ─── 回合内部状态 ──────────────────────────────────────

/** 终态分类：写进遥测，也是状态机落到哪个终态的判据。 */
type TerminalReason = 'completed' | 'cancelled' | 'error' | 'empty_response' | 'tool_turn_limit'

/** 完成分级：取消 > 硬错误 > 有工具失败但仍有输出 > 全部成功。 */
type CompletionStatus = 'success' | 'partial_success' | 'failed' | 'cancelled'

/** 用户主动停止一次回复的取消原因；它不改变「本会话自动允许」的授予。 */
const USER_CANCELLED_REASON = 'user-cancelled'

/** 顶替上一轮后台语音准备时记录的原因。 */
const VOICE_SUPERSEDED_REASON = 'voice-preparation-superseded'

/** 会话保存失败的用户可见说明（`app.bubble.error` 的插值参数）。 */
const SESSION_SAVE_FAILED = '会话保存失败'

/**
 * 未授权工作区时追加的 system 提示。
 * 它只进本次请求的请求消息，不进模型上下文，也不面向用户显示，因此不走文案端口。
 */
const WORKSPACE_UNAVAILABLE_HINT =
  '当前会话尚未授权工作区，文件与命令工具不可用。若任务需要访问文件，请明确提示用户点击界面下方的「工作区」按钮选择目录。'

/** say 让位的三条说明：互斥，按「失败 > 图片 > 用户跳过」的优先级取第一条。 */
const SAY_DEFERRED_TOOL_FAILED = '未说出：需要先读取并处理刚才的工具失败结果，再生成最终答复。'
const SAY_DEFERRED_IMAGES = '未说出：需要先观察刚读取的图片，再生成最终答复。'
const SAY_DEFERRED_SKIPPED = '未说出：需要先读取并处理用户跳过该操作的结果，再生成最终答复。'

/** say 回执的固定内容；与恢复历史时重放的合成结果逐字相同。 */
const SAY_ACKNOWLEDGED = '已说出'

/**
 * 一次回合的全部可变状态。
 *
 * 它取代原先由 5 个嵌套闭包共享改写的 11 个局部变量：这些绑定随回合对象一起被丢弃，
 * 下一个回合不会读到上一个回合的残留。
 */
interface Round {
  requestId: string
  /** 回合开始时的会话 id；后台语音据此判断自己是否已经换了会话。 */
  sessionId: string
  run: ConversationRun
  /** 后台语音准备的中止信号：与回合信号分开，取消语音不必中止整轮。 */
  voice: AbortController
  turnsUsed: number
  modelCallCount: number
  toolCallCount: number
  toolFailureCount: number
  fallbackUsed: boolean
  ttsRequested: boolean
  deliveredFinal: boolean
}

/** 一次回合内不变的环境：工具清单、检查点与已绑定检查点的工具执行器。 */
interface RoundEnvironment {
  round: Round
  tools: ToolDefinition[]
  sessionId: string
  checkpointId: string
  hasWorkspace: boolean
  toolExecution: ToolExecutionCoordinator
}

/**
 * 命名计时器：把回合内的耗时写进 trace 日志。
 * 走时钟端口而不是 performance.now，测试不依赖真实时间。
 */
function roundTimer(clock: ConversationClock, label: string) {
  const start = clock.monotonic()
  let stopped = false
  return {
    stop: (suffix?: string): number => {
      if (stopped) return 0
      stopped = true
      const elapsed = Math.round(clock.monotonic() - start)
      const tag = suffix ? ` ${suffix}` : ''
      log.trace('conversation_session.timer.trace', `[⏱Timer] ${label}${tag}: ${elapsed}ms`, { label, elapsed })
      return elapsed
    },
    lap: (tag: string): number => {
      const elapsed = Math.round(clock.monotonic() - start)
      log.trace('conversation_session.timer.trace', `[⏱Lap] ${label} — ${tag}: ${elapsed}ms`, { label, tag, elapsed })
      return elapsed
    },
  }
}

// ─── 编排器 ────────────────────────────────────────────

/**
 * 一次对话回合的编排器。
 *
 * 与框架无关：它只认识上面这些端口。回合的全部可变状态都收在实现内部，
 * 外部只能通过 send / cancel / projection / subscribe 观察它。
 */
export class ConversationSession {
  private readonly ports: ConversationSessionPorts
  private readonly maxToolTurns: number
  private readonly imageLimits: { maxCount: number; maxBytes: number }
  private readonly coordinator: ConversationCoordinator
  private readonly assistantMessages: AssistantMessageCoordinator
  private readonly listeners = new Set<ConversationProjectionListener>()
  private readonly messageListeners = new Set<ConversationMessageListener>()

  /** 最近一次启动的回合；它决定谁有权写共享投影。 */
  private latestRound: Round | null = null
  /** 正在后台准备语音的那个回合；没有准备中的语音时为 null。 */
  private voiceRound: Round | null = null

  /** 会话内自动允许后续文件操作；由批准决策授予，会话被替换时撤销。 */
  private autoExecSession = false

  /** 回合派生的界面状态：回合结束后保留最后一帧，直到下一个回合或 cancel 清空。 */
  private bubbleText = ''
  private typing = false
  private thinking = ''
  private activities: ConversationToolActivity[] = []

  /**
   * 端口齐备性在构造时校验：缺一个就抛错，取代今天的静默空实现。
   */
  constructor(ports: ConversationSessionPorts, options: ConversationSessionOptions = {}) {
    assertSessionPorts(ports)
    assertPositiveInteger(options.maxToolTurns, 'maxToolTurns')
    assertPositiveInteger(options.maxImageCount, 'maxImageCount')
    assertPositiveInteger(options.maxTotalImageBytes, 'maxTotalImageBytes')

    this.ports = ports
    this.maxToolTurns = options.maxToolTurns ?? MAX_TOOL_TURNS
    this.imageLimits = {
      maxCount: options.maxImageCount ?? MAX_IMAGE_COUNT,
      maxBytes: options.maxTotalImageBytes ?? MAX_TOTAL_IMAGE_BYTES,
    }
    // 工具回合的提交端口与模型上下文的追加侧在形状上本就同源，
    // 因此回合可以把工具调用/结果原样交给状态机，由它保证「先落库、再投影」。
    this.coordinator = new ConversationCoordinator(() => this.ports.clock.now(), {
      session: {
        recordToolCalls: input => this.ports.session.recordToolCalls(input),
        recordToolResult: input => this.ports.session.recordToolResult(input),
      },
      modelContext: {
        addToolCalls: (calls, visibleText) => this.ports.context.addToolCalls(calls, visibleText),
        addToolResult: (callId, content) => this.ports.context.addToolResult(callId, content),
        addToolImages: (toolCallIds, images) => this.ports.context.addToolImages(toolCallIds, images),
      },
    })
    this.assistantMessages = new AssistantMessageCoordinator({
      // 会话已经换走时，这次写入不再属于当前对话：不提交、不 revise。
      commit: async message => {
        if (this.ports.session.currentSessionId() !== message.sessionId) return null
        return this.ports.session.commitAssistantMessage(message)
      },
      revise: async revision => {
        if (this.ports.session.currentSessionId() !== revision.sessionId) return false
        return this.ports.session.reviseAssistantMessage(revision)
      },
    })
    // 语音是回复提交之后的独立副作用：只订阅已提交事件，不参与回合完成条件。
    // 同一条订阅也把消息事实转给展示层：界面列表先于语音更新，与迁移前 store 的顺序一致。
    this.assistantMessages.subscribe(event => {
      this.publishMessages(event)
      if (!event.playbackText?.trim()) return
      const character = this.ports.character.state()
      log.sensitiveDebug('conversation_session.voice_text_sensitive.debug', '送入 TTS 的语音文本', {
        requestId: event.requestId,
        voice_lang: character.voiceLanguage || '?',
        voice_text: event.playbackText,
      })
      this.ports.voice.play({
        requestId: event.requestId,
        text: event.playbackText,
        voiceId: character.voice || '',
        voiceLanguage: character.voiceLanguage,
      })
    })
    this.coordinator.subscribe(() => this.publish())
    // 等待批准要在投影里看得见：有待决请求进 awaiting-approval，待决清除再回到
    // executing-tools。驱动条件与原先 store 的批准订阅逐条相同。
    this.ports.toolExecution.subscribeApproval(pending => this.projectApproval(pending))
  }

  /** 送出一条输入并等它走到终态；结果由 SendResult 变体表达，不抛业务异常。 */
  async send(input: ConversationInput): Promise<SendResult> {
    const rawText = input.text ?? ''
    const images = input.images ?? []

    // ── 守卫条件检查 ────────────────────────────────────
    // 前两条守卫在任何副作用之前返回；下面两条在线/配置守卫则在
    // 回合已建、语音已取消、活动列表已重置之后才失败，顺序不可调换。
    if (this.isRoundActive()) {
      log.warn('conversation_session.reentrant.warn', `正在处理中，忽略重复请求 (text=${rawText.length} 字符)`)
      return { status: 'failed', requestId: null, turnsUsed: 0, reason: 'reentrant' }
    }
    if ((!rawText || !rawText.trim()) && images.length === 0) {
      log.warn('conversation_session.empty_input.warn', '收到空消息，忽略')
      return { status: 'failed', requestId: null, turnsUsed: 0, reason: 'empty-input' }
    }
    // 新消息到来时先结束上一轮的后台语音准备，避免旧语音覆盖新回复。
    this.stopVoicePreparation(VOICE_SUPERSEDED_REASON)

    const requestId = this.ports.clock.nextId('request')
    const run = this.coordinator.start(requestId)
    const round: Round = {
      requestId,
      sessionId: this.ports.session.currentSessionId(),
      run,
      voice: new AbortController(),
      turnsUsed: 0,
      modelCallCount: 0,
      toolCallCount: 0,
      toolFailureCount: 0,
      fallbackUsed: false,
      ttsRequested: false,
      deliveredFinal: false,
    }
    this.latestRound = round
    // 本次请求独立展示工具活动，等首个工具调用再点亮。
    this.activities = []
    this.publish()

    // 用户发送新消息时，取消正在播放的语音（不涉及回合）。
    this.ports.voice.cancel('new-message')

    const userText = rawText.trim() || this.ports.texts.imageOnlyPrompt()

    if (!this.ports.network.isOnline()) {
      log.warn('conversation_session.network_unavailable.warn', '网络不可用，无法发送消息')
      this.setBubbleText(this.ports.texts.networkOff())
      this.setTyping(false)
      this.coordinator.transition(requestId, 'failed', 'network-unavailable')
      return { status: 'failed', requestId, turnsUsed: 0, reason: 'network-unavailable' }
    }

    const configuration = this.ports.model.configuration()
    if (!configuration.ready) {
      log.warn('conversation_session.invalid_configuration.warn', 'API 未配置')
      this.setBubbleText(this.ports.texts.apiNotConfigured())
      this.setTyping(false)
      this.coordinator.transition(requestId, 'failed', 'invalid-configuration')
      return { status: 'failed', requestId, turnsUsed: 0, reason: 'invalid-configuration' }
    }

    const requestStartedAt = this.ports.clock.monotonic()
    log.info('chat.request_started', '对话请求开始', {
      requestId,
      textLength: rawText.length,
      imageCount: images.length,
      model: configuration.model,
    })

    // ── 先提交会话事实，再更新当前 UI 投影 ───────────────
    const userMsgId = this.ports.clock.nextId('user-message')
    const accepted = await this.ports.session.acceptUserMessage({
      sessionId: round.sessionId,
      messageId: userMsgId,
      text: userText,
      images: [...images],
    })
    if (!accepted) {
      // 此处 UI 与模型上下文都还没写，无需回滚。
      this.coordinator.transition(requestId, 'failed', 'session-persistence-failed')
      this.setBubbleText(this.ports.texts.error(SESSION_SAVE_FAILED))
      this.setTyping(false)
      return { status: 'failed', requestId, turnsUsed: 0, reason: 'session-persistence-failed' }
    }
    this.ports.context.addUserMessage(userText, images)
    this.publish()
    this.publishMessages({
      type: 'user-accepted',
      sessionId: round.sessionId,
      messageId: userMsgId,
      text: userText,
      images,
    })

    // 为本回合建立回档检查点（记录回合前的视觉状态；改文件工具执行时再按需备份文件）。
    // 它必须早于工具清单装配：检查点记录的是回合真正开始前的角色外观。
    let checkpointId: string
    try {
      checkpointId = await this.ports.session.beginCheckpoint(round.sessionId, userMsgId)
    } catch (error) {
      log.error('chat.session_checkpoint_failed', '会话检查点保存失败', error, { requestId })
      this.coordinator.transition(requestId, 'failed', 'session-persistence-failed')
      this.setBubbleText(this.ports.texts.error(SESSION_SAVE_FAILED))
      this.setTyping(false)
      return { status: 'failed', requestId, turnsUsed: 0, reason: 'session-persistence-failed' }
    }

    // ── 准备气泡 ────────────────────────────────────────
    this.bubbleText = ''
    this.typing = false
    this.thinking = ''
    this.publish()

    // ── 收集工具定义（含 say 说话工具）────────────────────
    const character = this.ports.character.state()
    const hasWorkspace = Boolean(this.ports.session.workspaceGrantId())
    const tools = [
      ...this.ports.tools.definitions({
        data: character.data,
        capabilities: character.capabilities,
        hasWorkspace,
      }),
      SAY_TOOL_DEF,
    ]

    // 检查点按回合绑定：文件备份走同一份会话事实端口。
    const toolExecution = this.ports.toolExecution.create({
      checkpoint: async path => {
        await this.ports.session.backupFile(round.sessionId, checkpointId, path)
        await this.ports.session.markCheckpointFiles(round.sessionId, checkpointId)
      },
      onCheckpointError: (error, path) => {
        log.warn('conversation_session.tool_checkpoint_failed', `文件备份失败（继续执行）: ${path}`, error)
      },
      onSessionApproval: () => {
        this.autoExecSession = true
        log.info('conversation_session.file_approval_session', '本会话自动允许后续文件操作')
        this.publish()
      },
    })

    const environment: RoundEnvironment = {
      round,
      tools,
      sessionId: round.sessionId,
      checkpointId,
      hasWorkspace,
      toolExecution,
    }

    log.trace('conversation_session.loop.trace', `工具循环开始 安全上限=${this.maxToolTurns} 轮`, {
      requestId,
      tool_turns: this.maxToolTurns,
      tool_count: tools.length,
    })
    const loopResult = await this.coordinator.runTurns(
      requestId,
      this.maxToolTurns,
      turn => this.performTurn(environment, turn),
    )
    round.turnsUsed = loopResult.turnsUsed

    // ── 循环结束 ────────────────────────────────────────
    let failed = false
    let wasCancelled = false
    let terminalReason: TerminalReason = 'completed'

    if (loopResult.status === 'cancelled') {
      wasCancelled = true
      log.info('conversation_session.cancelled.info', '请求被取消', { requestId, turns_used: round.turnsUsed })
    } else if (loopResult.status === 'failed') {
      const errMsg = loopResult.error instanceof Error ? loopResult.error.message : String(loopResult.error)
      log.error('chat.turn_failed', '对话执行失败', loopResult.error, {
        operation: 'send',
        turn: Math.max(0, round.turnsUsed - 1),
        requestId,
      })
      failed = true
      // 已被顶替的回合不得把错误气泡盖到新回合上。
      if (this.ownsRound(round)) {
        this.setBubbleText(this.ports.texts.error(errMsg))
        this.setTyping(false)
      }
    }

    // 被取消/取代时仍写统一完成事件，但不能覆盖后来请求的 UI 状态。
    const ownsRequestState = this.coordinator.mayProject(requestId)
    if (!ownsRequestState) {
      wasCancelled = true
      terminalReason = 'cancelled'
      log.info('chat.request_cancelled', '对话请求被替代或取消', { requestId })
    }

    if (wasCancelled) {
      // 用户主动取消：不展示兜底气泡。
      log.info('conversation_session.cancelled.info', '已取消，跳过兜底提示', { requestId })
    } else if (failed) {
      terminalReason = 'error'
    } else if (!round.deliveredFinal) {
      // 模型始终未交付最终回复：触达安全上限多半是陷入工具死循环。
      terminalReason = round.turnsUsed >= this.maxToolTurns ? 'tool_turn_limit' : 'empty_response'
      log.warn('conversation_session.no_final_reply.warn', '请求结束但没有可交付的最终回复', undefined, {
        requestId,
        terminal_reason: terminalReason,
        turns_used: round.turnsUsed,
      })
      if (ownsRequestState) {
        this.setBubbleText(this.ports.texts.done())
        this.setTyping(false)
      }
    }

    const completionStatus: CompletionStatus =
      wasCancelled ? 'cancelled'
        : failed || !round.deliveredFinal ? 'failed'
          : round.toolFailureCount > 0 ? 'partial_success'
            : 'success'

    if (ownsRequestState) {
      if (completionStatus === 'failed') {
        this.coordinator.transition(requestId, 'failed', terminalReason)
      } else {
        if (this.coordinator.current()?.state !== 'finalizing') {
          this.coordinator.transition(requestId, 'finalizing')
        }
        this.coordinator.transition(requestId, 'completed', terminalReason)
      }
    }

    const completedContext = {
      requestId,
      completionStatus,
      failed: completionStatus === 'failed',
      cancelled: wasCancelled,
      durationMs: Math.round(this.ports.clock.monotonic() - requestStartedAt),
      turnsUsed: round.turnsUsed,
      toolTurnLimit: this.maxToolTurns,
      toolDefinitionCount: tools.length,
      toolDefinitionTokens: this.ports.context.stats().toolDefinitionTokens,
      modelCallCount: round.modelCallCount,
      toolCallCount: round.toolCallCount,
      toolFailureCount: round.toolFailureCount,
      fallbackUsed: round.fallbackUsed,
      ttsStatus: round.ttsRequested ? 'pending' : 'not_requested',
      terminalReason: completionStatus === 'cancelled' ? 'cancelled' : failed ? 'error' : terminalReason,
    }
    if (completionStatus === 'failed') {
      log.error('chat.request_completed', '对话请求结束', new Error('对话请求失败'), completedContext)
    } else {
      log.info('chat.request_completed', '对话请求结束', completedContext)
    }

    if (wasCancelled) {
      return {
        status: 'cancelled',
        requestId,
        turnsUsed: round.turnsUsed,
        reason: run.snapshot().reason ?? 'cancelled',
      }
    }
    if (failed || !round.deliveredFinal) {
      // 触达轮次上限仍未交付单独成一类，便于调用方区分「模型抖动」与「工具死循环」。
      if (terminalReason === 'tool_turn_limit') {
        return { status: 'turn-limit', requestId, turnsUsed: round.turnsUsed }
      }
      return {
        status: 'failed',
        requestId,
        turnsUsed: round.turnsUsed,
        reason: terminalReason === 'empty_response' ? 'empty-response' : 'model-failure',
      }
    }
    return {
      status: 'success',
      requestId,
      turnsUsed: round.turnsUsed,
      partial: completionStatus === 'partial_success',
      fallbackUsed: round.fallbackUsed,
    }
  }

  /**
   * 取消当前回合；取消是回合计状态机的转移，不是另一份并行状态源。
   *
   * 这是唯一的收口入口：用户取消、会话切换、清空、角色切换、上下文替换都走它，
   * 回合与后台语音准备一起停 —— 调用方不需要记得分别取消两者。
   */
  cancel(reason: string = USER_CANCELLED_REASON): void {
    log.debug('conversation_session.cancel.debug', `取消对话请求 (reason=${reason})`, { reason })
    this.coordinator.cancelActive(reason)
    this.stopVoicePreparation(reason)
    this.ports.voice.cancel(reason, true)
    // 用户主动停止一次回复不改变「本会话允许自动操作」的授予；
    // 会话被切换、清空或上下文被替换时，授予随之失效。
    if (reason !== USER_CANCELLED_REASON) this.autoExecSession = false
    this.bubbleText = ''
    this.typing = false
    this.thinking = ''
    this.publish()
  }

  /** 当前投影。 */
  projection(): ConversationProjection {
    // 终态回合仍是「当前回合」：runId / revision 保留到下一个回合启动，
    // 订阅者据此判断投影是否真的前进过。
    const snapshot = this.coordinator.current()
    return {
      runId: snapshot?.id ?? null,
      runState: snapshot?.state ?? 'idle',
      revision: snapshot?.revision ?? 0,
      bubbleText: this.bubbleText,
      typing: this.typing,
      thinking: this.thinking,
      toolActivities: this.activities.map(activity => ({ ...activity })),
      context: this.ports.context.stats(),
      autoExecSession: this.autoExecSession,
    }
  }

  /**
   * 订阅投影变更，返回退订函数。
   * 订阅时立刻回调一次当前投影，与 ConversationRun.subscribe 一致。
   */
  subscribe(listener: ConversationProjectionListener): () => void {
    this.listeners.add(listener)
    listener(this.projection())
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 订阅已提交的用户消息与已提交 / 已修订的助手消息，返回退订函数。
   *
   * 它订阅的是会话事实，不是回合状态：没有「订阅时立刻回调一次」的语义，
   * 因为事实只在发生的那一刻存在。
   */
  subscribeMessages(listener: ConversationMessageListener): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  // ── 回合循环 ──────────────────────────────────────────

  /** 是否已有进行中的回合（重入守卫的判据）。 */
  private isRoundActive(): boolean {
    const snapshot = this.coordinator.current()
    return snapshot !== null && isConversationRunActive(snapshot.state)
  }

  /**
   * 本回合是否仍拥有共享投影的写权限。
   * 被新回合顶替、信号已中止或状态机已进终态时即失去写权限。
   */
  private ownsRound(round: Round): boolean {
    return this.latestRound === round && this.coordinator.mayProject(round.requestId)
  }

  /**
   * 结束后台语音准备。
   *
   * 语音准备自己的中止信号与回合信号分开：取消语音准备不必中止整轮，
   * 而回合被取消时语音准备会通过回合信号一并失效。
   */
  private stopVoicePreparation(reason: string): void {
    const round = this.voiceRound
    if (!round) return
    this.voiceRound = null
    round.voice.abort(reason)
  }

  /** 后台语音准备是否已被中止（自身信号或所属回合的信号）。 */
  private voiceStopped(round: Round): boolean {
    return round.voice.signal.aborted || round.run.signal.aborted
  }

  /**
   * 回合内唯一一处翻译闭包：人设、取消信号与遥测关联都绑定在本次回合上。
   *
   * 后台语音准备传入自己的中止信号（见 startVoicePreparation）：它的翻译属于
   * 可以随时作废的那部分工作，作废时应当连同在途请求一起中止。
   */
  private translatorFor(round: Round, turn: number, signal: AbortSignal = round.run.signal): TranslateFn {
    const { persona } = this.ports.character.state()
    return (text, targetLang, opts) => this.ports.translate.translate(text, targetLang, {
      persona,
      signal,
      requestId: round.requestId,
      turn,
      ttsSafe: opts?.ttsSafe,
    })
  }

  /** 执行一次模型轮次，并说明领域流程是否还需要下一轮。 */
  private async performTurn(environment: RoundEnvironment, turn: number): Promise<ConversationTurnDirective> {
    const { round, tools } = environment
    round.turnsUsed = turn + 1
    const turnTimer = roundTimer(this.ports.clock, `turn#${turn}`)

    const streamDecoder = new ModelStreamDecoder()
    const chatTimer = roundTimer(this.ports.clock, `turn#${turn} model-call`)

    /** 流式正文只在仍拥有投影时写回，且与当前值不同才写（减少响应式触发）。 */
    const renderStreamText = (text: string) => {
      if (!this.ownsRound(round)) return
      if (this.bubbleText !== text) this.bubbleText = text
      this.typing = Boolean(text)
      this.publish()
    }

    // 流协议解析由 ModelStreamDecoder 负责；回合只投影解码结果。
    round.modelCallCount++
    const result = await this.ports.model.call({
      requestId: round.requestId,
      turn,
      messages: this.requestMessages(tools, environment.hasWorkspace),
      tools,
      signal: round.run.signal,
      onChunk: (delta: string) => {
        const decoded = streamDecoder.pushContent(delta)
        if (!this.ownsRound(round)) return
        this.thinking = decoded.thinking
        this.bubbleText = decoded.visibleText
        this.typing = Boolean(decoded.visibleText)
        this.publish()
      },
      onThinking: (chunk: string) => {
        const decoded = streamDecoder.pushThinking(chunk)
        if (!this.ownsRound(round)) return
        this.thinking = decoded.thinking
        this.publish()
      },
      onToolCallDelta: (calls: readonly ToolCallData[]) => {
        const sayCall = calls.find(call => call.function?.name === SAY_TOOL_NAME)
        if (!sayCall) return
        const partial = extractPartialSayArgs(sayCall.function.arguments || '')
        const { voiceLanguage, displayLanguage } = this.ports.character.state()
        const visible = partial.display?.trim()
          || (voiceLanguage === displayLanguage ? partial.voice?.trim() : '')
        if (visible) renderStreamText(visible)
      },
    })
    chatTimer.stop()

    const interpreted = interpretModelTurn(result, streamDecoder.snapshot(), {
      requestId: round.requestId,
      turn,
      sayToolName: SAY_TOOL_NAME,
      extractTextToolCalls: text => this.ports.tools.extractTextToolCalls(text),
      stripTextToolCalls: text => this.ports.tools.stripTextToolCalls(text),
    })

    if (interpreted.type === 'empty') {
      log.warn('conversation_session.empty_turn.warn', `第${turn}轮 AI 返回空内容`, undefined, { requestId: round.requestId, turn })
      turnTimer.stop('empty — break')
      return 'complete'
    }

    if (interpreted.type === 'final-text') {
      // 模型没调 say 就直接输出正文：正文当显示文本，并补一份母语台词。
      round.fallbackUsed = true
      const visibleText = interpreted.text
      const translate = this.translatorFor(round, turn)
      const { voiceLanguage, displayLanguage } = this.ports.character.state()
      this.renderBubble(round, visibleText, true)
      const { voice, display } = await resolveContentFallback(visibleText, voiceLanguage, displayLanguage, translate)
      this.commitSyntheticSay(round, voice, display)
      await this.deliver(round, 'text-fallback', voice, display)
      turnTimer.stop('text — break')
      return 'complete'
    }

    const { batch } = interpreted
    const { sayCall } = batch
    if (sayCall) {
      const rawForLog = parseSayArgs(sayCall.function.arguments || '{}')
      log.sensitiveDebug('conversation_session.say_sensitive.debug', `第${turn}轮 say 原始文本`, {
        requestId: round.requestId,
        turn,
        voice: rawForLog.voice ?? '',
        display: rawForLog.display ?? '',
      })
    }

    // 清掉上一轮的正文，避免它抢在工具结果之前成为最终答复。
    this.renderBubble(round, '', false)
    // 工具调用必须先落库，再执行、再暴露给模型上下文。
    await this.coordinator.commitToolCalls(round.requestId, {
      sessionId: environment.sessionId,
      stepId: `${round.requestId}:${turn}`,
      calls: batch.protocolCalls,
      visibleText: batch.assistantText,
    })
    const { toolImages, actionBatchFailed, actionBatchNeedsFollowup } = await this.executeActionBatch(environment, batch)

    // say 不能抢在同批动作的图片、失败或拒绝结果之前成为最终答复。
    if (sayCall && (toolImages.length || actionBatchNeedsFollowup)) {
      this.renderTyping(round, false)
      const reason = actionBatchFailed
        ? SAY_DEFERRED_TOOL_FAILED
        : toolImages.length ? SAY_DEFERRED_IMAGES : SAY_DEFERRED_SKIPPED
      await this.coordinator.commitToolResult(round.requestId, {
        sessionId: environment.sessionId,
        callId: sayCall.id,
        content: reason,
        status: 'rejected',
        code: 'SAY_DEFERRED',
      })
      this.coordinator.appendToolImages(round.requestId, this.actionCallIds(batch), toolImages)
      turnTimer.stop(actionBatchFailed ? 'tool-failed — continue' : 'tool-followup — continue')
      return 'continue'
    }

    if (sayCall) {
      const translate = this.translatorFor(round, turn)
      const raw = parseSayArgs(sayCall.function.arguments || '{}')
      const { voiceLanguage, displayLanguage } = this.ports.character.state()
      const displayPreview = raw.display?.trim() || (voiceLanguage === displayLanguage ? raw.voice?.trim() : '')
      if (displayPreview) this.renderBubble(round, displayPreview, false)
      // 会话时间线上 say 回执在前、assistant 消息在后。
      await this.coordinator.commitToolResult(round.requestId, {
        sessionId: environment.sessionId,
        callId: sayCall.id,
        content: SAY_ACKNOWLEDGED,
        status: 'succeeded',
      })
      if (displayPreview) {
        // voice 用原始未清洗的台词提交，清洗与译文在后台继续。
        const messageId = await this.commitAssistant(round, displayPreview, raw.voice, 'say')
        if (messageId) {
          this.startVoicePreparation(round, messageId, raw, voiceLanguage, displayLanguage, turn, displayPreview)
        }
      } else {
        const { voice, display } = await resolveSayContent(raw, voiceLanguage, displayLanguage, translate)
        if (voice || display) await this.deliver(round, 'say', voice, display)
        else log.warn('conversation_session.empty_say.warn', `第${turn}轮 say 内容为空`, undefined, { requestId: round.requestId, turn })
      }
      turnTimer.stop('say — break')
      return 'complete'
    }

    if (toolImages.length) {
      this.coordinator.appendToolImages(round.requestId, this.actionCallIds(batch), toolImages)
    }
    this.renderTyping(round, false)
    if (batch.assistantText?.trim()) {
      // 动作工具执行前的正文有意丢弃：它既不进气泡，也不进会话事实。
      log.debug('conversation_session.pre_tool_text.debug', `第${turn}轮忽略工具执行前正文并继续`, {
        requestId: round.requestId,
        turn,
        pre_tool_text_length: batch.assistantText.length,
      })
    }
    turnTimer.stop('actions — continue')
    return 'continue'
  }

  /** 本次请求要发给模型的消息；未授权工作区时追加一条 system 提示。 */
  private requestMessages(tools: readonly ToolDefinition[], hasWorkspace: boolean): ConversationModelMessage[] {
    const messages = [...this.ports.context.messages(tools)]
    if (!hasWorkspace) messages.push({ role: 'system', content: WORKSPACE_UNAVAILABLE_HINT })
    return messages
  }

  /** 让原生调用与文本兜底调用走同一条归一化批次路径。 */
  private async executeActionBatch(environment: RoundEnvironment, batch: ToolCallBatch) {
    const { round } = environment
    if (batch.actions.length > 0) this.coordinator.transition(round.requestId, 'executing-tools')
    const toolImages: ImageAttachment[] = []
    const result = await executeToolCallBatch(
      batch.actions,
      call => this.executeWithPolicy(environment, call),
      {
        onStart: invocation => {
          const { protocolCall, parseError } = invocation
          round.toolCallCount++
          this.beginActivity(round, protocolCall.id, protocolCall.function.name || '?')
          log.info('chat.tool_started', `执行工具: ${protocolCall.function.name || '?'}`, {
            requestId: round.requestId,
            turn: round.turnsUsed - 1,
            toolCallId: protocolCall.id,
            toolName: protocolCall.function.name || '?',
            source: batch.source,
          })
          if (parseError) {
            log.error('conversation_session.tool_arguments_invalid', `工具参数 JSON 解析失败: ${parseError.message}`, new Error(parseError.message), {
              requestId: round.requestId,
              turn: round.turnsUsed - 1,
              toolCallId: protocolCall.id,
              toolName: protocolCall.function.name || '?',
              source: batch.source,
            })
          }
        },
        onResult: async ({ invocation, result: toolResult }) => {
          const { protocolCall } = invocation
          if (collectToolImages(toolResult, toolImages, this.imageLimits)) {
            toolResult.content += toolImageLimitNotice(this.imageLimits)
          }
          // UI 活动状态先于持久化。
          this.endActivity(round, protocolCall.id, resultStatus(toolResult))
          log.sensitiveDebug('conversation_session.tool_result_sensitive.debug', '工具执行结果', {
            requestId: round.requestId,
            turn: round.turnsUsed - 1,
            tool_name: protocolCall.function.name || '?',
            source: batch.source,
            tool_result_content: (toolResult.content || '').slice(0, 200),
          })
          await this.coordinator.commitToolResult(round.requestId, {
            sessionId: environment.sessionId,
            callId: protocolCall.id,
            content: toolResult.content,
            status: isToolSkipped(toolResult) ? 'rejected' : isToolError(toolResult) ? 'failed' : 'succeeded',
            code: toolResult.code,
          })
        },
      },
    )
    round.toolFailureCount += result.failureCount
    return {
      toolImages,
      actionBatchFailed: result.failureCount > 0,
      actionBatchNeedsFollowup: result.needsFollowup,
    }
  }

  /** 每次都现取工作区授权：一个回合内用户可能中途授权。 */
  private executeWithPolicy(environment: RoundEnvironment, call: ToolCall): Promise<ToolResult> {
    return environment.toolExecution.execute(call, {
      signal: environment.round.run.signal,
      sessionApproval: this.autoExecSession,
      hasWorkspace: Boolean(this.ports.session.workspaceGrantId()),
    })
  }

  /** 把最终可见文本落地：写气泡、提交会话事实。 */
  private async commitAssistant(
    round: Round,
    display: string,
    voice: string | undefined,
    source: 'say' | 'text-fallback',
    playbackText?: string,
  ): Promise<string | null> {
    // 已取消：翻译兜底期间被中止时不交付、不落盘、不播报。
    if (round.run.signal.aborted) return null
    this.coordinator.transition(round.requestId, 'finalizing')
    this.renderBubble(round, display, false)
    const event = await this.assistantMessages.commit({
      requestId: round.requestId,
      sessionId: round.sessionId,
      display,
      thinking: this.thinking || undefined,
      voice,
      source,
      playbackText,
    })
    if (!event) return null
    round.deliveredFinal = true
    return event.messageId
  }

  /** 把最终台词落地：提交之后才交给语音，语音不属于回合完成条件。 */
  private async deliver(
    round: Round,
    source: 'say' | 'text-fallback',
    voice: string,
    display: string,
  ): Promise<void> {
    const messageId = await this.commitAssistant(round, display, voice, source, voice)
    if (!messageId) return
    round.ttsRequested = true
  }

  /**
   * 把一段台词作为合成的 say 工具调用写入模型上下文。
   * 用于兜底路径（模型没调 say）：使实时上下文与会话恢复重建的范式保持一致 ——
   * 助手回合始终表现为 say 调用，避免「纯文本回合」污染范式、诱导模型后续不再调工具。
   */
  private commitSyntheticSay(round: Round, voice: string, display: string): void {
    if (!this.ownsRound(round)) return
    const call: ProtocolToolCall = {
      id: this.ports.clock.nextId('say-synthetic'),
      type: 'function',
      function: { name: SAY_TOOL_NAME, arguments: JSON.stringify({ voice, display }) },
    }
    this.coordinator.appendSyntheticToolExchange(round.requestId, call, SAY_ACKNOWLEDGED)
  }

  /**
   * 可见文本已流式显示后，在后台继续完成语音清洗、历史回填和 TTS。
   * 这样语音模型尚未返回时，输入框可以立即解锁。
   *
   * 它只持有一个属于本回合的中止信号：新回合顶替、用户取消、会话切换都从
   * cancel / send 的同一个入口过来，越界由模块边界拦住，而不是靠调用方记得取消。
   */
  private startVoicePreparation(
    round: Round,
    messageId: string,
    raw: { voice?: string; display?: string },
    voiceLang: string,
    displayLang: string,
    turn: number,
    displayPreview: string,
  ): void {
    const { requestId, sessionId } = round
    const translate = this.translatorFor(round, turn, round.voice.signal)
    const voiceStartedAt = this.ports.clock.monotonic()
    let playbackStarted = false
    const completeBeforePlayback = (status: 'cancelled' | 'failed', reason: string) => {
      const context = {
        requestId,
        status,
        reason,
        durationMs: Math.round(this.ports.clock.monotonic() - voiceStartedAt),
      }
      if (status === 'failed') log.warn('tts.playback_completed', 'TTS 播放结束', undefined, context)
      else log.info('tts.playback_completed', 'TTS 播放结束', context)
    }

    round.ttsRequested = true
    this.voiceRound = round
    void (async () => {
      try {
        const { voice, display } = await resolveSayContent(raw, voiceLang, displayLang, translate)
        if (this.voiceStopped(round)) {
          completeBeforePlayback('cancelled', 'voice_preparation_cancelled')
          return
        }
        if (this.ports.session.currentSessionId() !== sessionId) {
          completeBeforePlayback('cancelled', 'session_changed')
          return
        }
        log.sensitiveDebug('conversation_session.say_resolved_sensitive.debug', 'say 后台最终文本', {
          requestId,
          voice,
          display,
        })
        const revised = await this.assistantMessages.revise({
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
        if (this.latestRound === round && this.bubbleText === displayPreview && display && display !== displayPreview) {
          this.bubbleText = display
          this.publish()
        }
        playbackStarted = true
        log.info('conversation_session.voice_prepared.info', 'say 后台语音准备完成', {
          requestId,
          display_length: display.length,
          voice_length: voice.length,
        })
      } catch (error) {
        const stopped = this.voiceStopped(round)
        log.warn('conversation_session.voice_preparation_failed.warn', `后台语音准备失败: ${(error as Error).message}`, error)
        if (!playbackStarted) {
          completeBeforePlayback(
            stopped ? 'cancelled' : 'failed',
            stopped ? 'voice_preparation_cancelled' : (error as Error).message,
          )
        }
      } finally {
        if (this.voiceRound === round) this.voiceRound = null
      }
    })()
  }

  // ── 工具活动 ──────────────────────────────────────────

  /** 新增一条「执行中」活动。被顶替的回合不得修改新回合的共享活动状态。 */
  private beginActivity(round: Round, id: string, name: string): void {
    if (!this.ownsRound(round)) return
    this.activities.push({ id, name, status: 'running' })
    this.publish()
  }

  /** 把指定活动标记为完成 / 失败 / 跳过。 */
  private endActivity(round: Round, id: string, status: ConversationToolActivity['status']): void {
    if (!this.ownsRound(round)) return
    const activity = this.activities.find(item => item.id === id)
    if (activity) activity.status = status
    this.publish()
  }

  private actionCallIds(batch: ToolCallBatch): string {
    return batch.actions.map(action => action.protocolCall.id).join(', ')
  }

  // ── 投影 ──────────────────────────────────────────────

  /**
   * 批准网关的待决状态驱动回合计状态机。
   *
   * 以 coordinator 当前的回合计为目标，因此已经终结或被顶替的回合不会被迟到的
   * 网关事件拉回非终态（transition 按 id + 非终态判定，失败即沉默）。
   */
  private projectApproval(pending: boolean): void {
    const active = this.coordinator.current()
    if (!active) return
    if (pending) {
      this.coordinator.transition(active.id, 'awaiting-approval')
    } else if (active.state === 'awaiting-approval') {
      this.coordinator.transition(active.id, 'executing-tools')
    }
  }

  /** 只在仍拥有投影时写气泡与输入态：被顶替的回合不得覆盖新回合的界面状态。 */
  private renderBubble(round: Round, text: string, typing: boolean): void {
    if (!this.ownsRound(round)) return
    this.bubbleText = text
    this.typing = typing
    this.publish()
  }

  /** 只在仍拥有投影时写输入态，正文保持不变。 */
  private renderTyping(round: Round, typing: boolean): void {
    if (!this.ownsRound(round)) return
    this.typing = typing
    this.publish()
  }

  private setBubbleText(text: string): void {
    this.bubbleText = text
    this.publish()
  }

  private setTyping(typing: boolean): void {
    this.typing = typing
    this.publish()
  }

  private publish(): void {
    if (this.listeners.size === 0) return
    const projection = this.projection()
    for (const listener of [...this.listeners]) listener(projection)
  }

  private publishMessages(event: ConversationMessageEvent): void {
    for (const listener of [...this.messageListeners]) listener(event)
  }
}

// ─── 端口校验 ──────────────────────────────────────────

const SESSION_PORT_NAMES: readonly (keyof ConversationSessionPorts)[] = [
  'model',
  'translate',
  'character',
  'context',
  'session',
  'tools',
  'toolExecution',
  'voice',
  'clock',
  'network',
  'texts',
]

const SESSION_PORT_LABELS: Readonly<Record<keyof ConversationSessionPorts, string>> = {
  model: '模型客户端',
  translate: '翻译',
  character: '角色人设来源',
  context: '模型上下文',
  session: '会话事实',
  tools: '工具清单',
  toolExecution: '工具执行',
  voice: '语音播放入口',
  clock: '时钟与 id 生成',
  network: '在线状态探测',
  texts: '界面文案',
}

/** 每个端口必须具备的方法。缺任一项即视为这一处没有装配。 */
const SESSION_PORT_MEMBERS: Readonly<Record<keyof ConversationSessionPorts, readonly string[]>> = {
  model: ['configuration', 'call'],
  translate: ['translate'],
  character: ['state'],
  context: ['messages', 'addUserMessage', 'addToolCalls', 'addToolResult', 'addToolImages', 'stats'],
  session: [
    'currentSessionId',
    'workspaceGrantId',
    'acceptUserMessage',
    'recordToolCalls',
    'recordToolResult',
    'commitAssistantMessage',
    'reviseAssistantMessage',
    'beginCheckpoint',
    'backupFile',
    'markCheckpointFiles',
    'clearConversation',
  ],
  tools: ['definitions', 'extractTextToolCalls', 'stripTextToolCalls'],
  toolExecution: ['create', 'subscribeApproval'],
  voice: ['play', 'cancel'],
  clock: ['now', 'monotonic', 'nextId'],
  network: ['isOnline'],
  texts: ['imageOnlyPrompt', 'networkOff', 'apiNotConfigured', 'error', 'done'],
}

/** 可调参数都是安全护栏，给错值不如当场失败。 */
function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ConversationSession 的 ${name} 必须是正整数：${value}`)
  }
}

/**
 * 缺装配必须显式失败：错误信息里点出缺的是哪个端口、少了哪个方法。
 * 静默空转会让消息看起来发送成功，却在会话文件里什么都没留下。
 */
function assertSessionPorts(ports: ConversationSessionPorts): void {
  const given = ports as unknown as Record<string, unknown> | null | undefined
  for (const name of SESSION_PORT_NAMES) {
    const label = SESSION_PORT_LABELS[name]
    const port = given?.[name]
    if (!port || typeof port !== 'object') {
      throw new Error(`ConversationSession 缺少端口：${name}（${label}）`)
    }
    const candidate = port as Record<string, unknown>
    const missing = SESSION_PORT_MEMBERS[name].filter(member => typeof candidate[member] !== 'function')
    if (missing.length > 0) {
      const methods = missing.map(member => `${member}()`).join('、')
      throw new Error(`ConversationSession 的 ${name} 端口（${label}）缺少方法：${methods}`)
    }
  }
}
