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
import type { ContextStats } from '../../ai/context'
import type { ChatMessage as ConversationModelMessage, ToolCallData } from '../../ai/types'
import type { ToolCall, ToolDefinition } from '../../agent/types'
import type { CharacterToolContext } from '../../agent/registry'
import type { CharacterData } from '../../character/loader'
import type { ConversationImage } from '../../domain/conversation/events'
import type { CharacterCapabilities } from '../character/characterRuntime'
import type { ToolExecutionCoordinator } from '../tools/toolExecutionCoordinator'
import type { ChatSessionPort } from './chatSessionPort'
import type { ConversationRunState, ConversationToolTurnPorts } from './conversationRun'
import type { RawModelTurn } from './modelTurnInterpreter'

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
}

export type ConversationProjectionListener = (projection: ConversationProjection) => void

/**
 * 回合编排的可调参数。
 * 它们不是对外部世界的依赖，因此不进端口集合；缺省值由实现取既有常量。
 */
export interface ConversationSessionOptions {
  /** 模型调用轮次的安全上限（今日为 MAX_TOOL_TURNS），防止模型陷入永不 say 的工具死循环。 */
  maxToolTurns?: number
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

/**
 * 工具执行端口：复用既有的 ToolExecutionCoordinator 与它的策略。
 * 批准网关、执行策略与执行器由组合根持有；检查点回调按回合绑定，故每回合构造一次。
 */
export interface ConversationToolExecutionPort {
  create(round: ConversationToolRoundHooks): ToolExecutionCoordinator
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
}

// ─── 编排器 ────────────────────────────────────────────

/**
 * 一次对话回合的编排器。
 *
 * 与框架无关：它只认识上面这些端口。回合的全部可变状态都收在实现内部，
 * 外部只能通过 send / cancel / projection / subscribe 观察它。
 */
export class ConversationSession {
  /**
   * 端口齐备性在构造时校验：缺一个就抛错，取代今天的静默空实现。
   * 端口的持有与回合编排由 #16 落地。
   */
  constructor(ports: ConversationSessionPorts, options: ConversationSessionOptions = {}) {
    assertSessionPorts(ports)
    const { maxToolTurns } = options
    if (maxToolTurns !== undefined && (!Number.isInteger(maxToolTurns) || maxToolTurns < 1)) {
      throw new Error(`ConversationSession 的 maxToolTurns 必须是正整数：${maxToolTurns}`)
    }
  }

  /** 送出一条输入并等它走到终态；结果由 SendResult 变体表达，不抛业务异常。 */
  async send(_input: ConversationInput): Promise<SendResult> {
    throw new Error('ConversationSession 的回合编排尚未实现')
  }

  /** 取消当前回合；取消是回合计状态机的转移，不是另一份并行状态源。 */
  cancel(_reason?: string): void {
    throw new Error('ConversationSession 的回合编排尚未实现')
  }

  /** 当前投影。 */
  projection(): ConversationProjection {
    throw new Error('ConversationSession 的回合编排尚未实现')
  }

  /**
   * 订阅投影变更，返回退订函数。
   * 订阅时立刻回调一次当前投影，与 ConversationRun.subscribe 一致。
   */
  subscribe(_listener: ConversationProjectionListener): () => void {
    throw new Error('ConversationSession 的回合编排尚未实现')
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
  toolExecution: ['create'],
  voice: ['play', 'cancel'],
  clock: ['now', 'monotonic', 'nextId'],
  network: ['isOnline'],
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
