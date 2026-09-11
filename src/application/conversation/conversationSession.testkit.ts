/**
 * ConversationSession 的手写假端口。
 *
 * 回合的环境依赖全部经构造注入，所以测试不需要 Pinia、不需要 mock 整个 AI 模块，
 * 也不需要手工拼一个 11 方法的端口字面量 —— 这里的每个假端口都只实现它自己那条缝。
 *
 * 假端口同时记录「发生了什么」与「以什么顺序发生」，让行为断言不必去读日志缓冲区。
 */
import { ApprovalGateway } from '../tools/approvalGateway'
import {
  ToolExecutionCoordinator,
  type ToolExecutionContext,
  type ToolExecutionPolicy,
} from '../tools/toolExecutionCoordinator'
import { ConversationSession } from './conversationSession'

import type { ContextStats } from '../../ai/context'
import type { ChatMessage as ConversationModelMessage } from '../../ai/types'
import type { ToolCall, ToolDefinition, ToolResult } from '../../agent/types'
import type { CharacterToolContext } from '../../agent/registry'
import type { ConversationImage } from '../../domain/conversation/events'
import type { CommitAssistantMessage, ReviseAssistantMessage } from './assistantMessageCoordinator'
import type {
  ConversationApprovalListener,
  ConversationCharacterSource,
  ConversationCharacterState,
  ConversationClock,
  ConversationIdKind,
  ConversationModelClient,
  ConversationModelContext,
  ConversationModelRequest,
  ConversationNetworkProbe,
  ConversationSessionOptions,
  ConversationSessionPorts,
  ConversationTexts,
  ConversationToolCatalog,
  ConversationToolExecutionPort,
  ConversationToolRoundHooks,
  ConversationTranslateContext,
  ConversationTranslator,
  ConversationVoicePort,
  ConversationVoiceRequest,
} from './conversationSession'
import type { RawModelTurn } from './modelTurnInterpreter'
import type { ProtocolToolCall } from './toolCallBatch'

/** 一次模型调用的脚本：固定结果，或按请求临时决定。 */
export type TurnScript = RawModelTurn | ((request: ConversationModelRequest) => RawModelTurn | Promise<RawModelTurn>)

/** 可手动兑现的 Promise，用来制造「请求还在途中」的时机。 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

/** 一个原生的动作工具调用。 */
export function actionCall(name: string, id = `action-${name}`): ProtocolToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } }
}

/** 一个原生的 say 调用；`extra` 是同批执行的动作工具。 */
export function sayTurn(id: string, args: { voice?: string; display?: string }, extra: ProtocolToolCall[] = []): TurnScript {
  return {
    type: 'tools',
    calls: [
      ...extra,
      { id, type: 'function', function: { name: 'say', arguments: JSON.stringify(args) } },
    ],
  }
}

/** 一个需要走翻译兜底的 say：voice 含下划线，本地归一化一定放弃。 */
export const UNRESOLVED_VOICE = 'hello_world'

/** 只对第一次调用要求批准的策略，供批准生命周期测试复用。 */
export function approvalPolicyOnlyFirstTime(decisions: readonly ('allow' | 'allow-session' | 'reject')[]): {
  prepare: ToolExecutionPolicy['prepare']
  requested: () => number
} {
  let remaining = 1
  let requested = 0
  return {
    prepare: async call => {
      if (remaining-- <= 0) return { call }
      requested++
      return {
        call,
        approval: {
          id: `approval-${requested}`,
          toolName: call.name,
          args: call.arguments,
          kind: 'file',
          path: 'notes.txt',
          allowedDecisions: decisions,
        },
      }
    },
    requested: () => requested,
  }
}

/** 一批不含 say 的动作工具调用。 */
export function actionTurn(name: string, id = `action-${name}`): TurnScript {
  return {
    type: 'tools',
    calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
  }
}

// ─── 单个端口 ──────────────────────────────────────────

export class FakeClock implements ConversationClock {
  private tick = 0
  private readonly sequences = new Map<ConversationIdKind, number>()

  now(): number { return 1_700_000_000_000 + this.tick++ }
  monotonic(): number { return this.tick++ }

  nextId(kind: ConversationIdKind): string {
    const next = (this.sequences.get(kind) ?? 0) + 1
    this.sequences.set(kind, next)
    return `${kind}-${next}`
  }
}

export class FakeModelClient implements ConversationModelClient {
  readonly requests: ConversationModelRequest[] = []
  ready = true
  model = 'fake-model'
  private readonly script: TurnScript[] = []

  configuration() { return { ready: this.ready, model: this.model } }

  enqueue(...turns: TurnScript[]): void { this.script.push(...turns) }

  async call(request: ConversationModelRequest): Promise<RawModelTurn> {
    this.requests.push(request)
    const turn = this.script.shift()
    if (!turn) throw new Error(`FakeModelClient 没有为第 ${this.requests.length} 次调用准备轮次结果`)
    return typeof turn === 'function' ? turn(request) : turn
  }
}

export class FakeTranslator implements ConversationTranslator {
  readonly calls: { text: string; targetLang: string; context: ConversationTranslateContext }[] = []
  /** 默认译文带目标语言前缀，便于断言「翻译确实被调用过」。 */
  handler: ConversationTranslator['translate'] =
    async (text, targetLang) => `${targetLang}:${text}`

  translate(text: string, targetLang: string, context: ConversationTranslateContext): Promise<string> {
    this.calls.push({ text, targetLang, context })
    return this.handler(text, targetLang, context)
  }
}

export class FakeCharacterSource implements ConversationCharacterSource {
  value: ConversationCharacterState = {
    identity: { id: 'char-1', name: '小明' },
    persona: '小明',
    voice: 'voice-1',
    voiceLanguage: 'ja-JP',
    displayLanguage: 'zh-CN',
    render: 'illustration',
    data: null,
    capabilities: null,
  }

  state(): ConversationCharacterState { return this.value }
}

export class FakeModelContext implements ConversationModelContext {
  readonly conversation: ConversationModelMessage[] = []
  readonly userMessages: { text: string; images: readonly ConversationImage[] }[] = []
  readonly toolCallLog: ProtocolToolCall[][] = []
  readonly toolResultLog: { callId: string; content: string }[] = []
  readonly toolImageLog: { toolCallIds: string; images: readonly ConversationImage[] }[] = []
  readonly requestedTools: ToolDefinition[][] = []
  statsValue: ContextStats = {
    estimatedTokens: 42,
    maxContextTokens: 1000,
    toolDefinitionTokens: 7,
    messageCount: 0,
    summarizedRounds: 0,
    prunedMessages: 0,
    utilization: 0.042,
  }

  messages(tools: readonly ToolDefinition[]): readonly ConversationModelMessage[] {
    this.requestedTools.push([...tools])
    return [...this.conversation]
  }

  addUserMessage(text: string, images: readonly ConversationImage[]): void {
    this.userMessages.push({ text, images })
    this.conversation.push({ role: 'user', content: text })
  }

  addToolCalls(calls: readonly ProtocolToolCall[], visibleText?: string): void {
    this.toolCallLog.push([...calls])
    this.conversation.push({
      role: 'assistant',
      content: visibleText ?? '',
      tool_calls: calls.map(call => ({ ...call })),
    })
  }

  addToolResult(callId: string, content: string): void {
    this.toolResultLog.push({ callId, content })
    this.conversation.push({ role: 'tool', tool_call_id: callId, content })
  }

  addToolImages(toolCallIds: string, images: readonly ConversationImage[]): void {
    this.toolImageLog.push({ toolCallIds, images: [...images] })
  }

  stats(): ContextStats { return { ...this.statsValue } }
}

export class FakeChatSessionPort {
  /** 会话事实的提交顺序；断言 §U 的顺序依赖时读它。 */
  readonly events: string[] = []
  readonly accepted: { sessionId: string; messageId: string; text: string; images: readonly ConversationImage[] }[] = []
  readonly recordedCalls: { sessionId: string; stepId: string; calls: readonly unknown[]; visibleText?: string }[] = []
  readonly recordedResults: { sessionId: string; callId: string; content: string; status: string; code?: string }[] = []
  readonly assistantMessages: CommitAssistantMessage[] = []
  readonly revisions: ReviseAssistantMessage[] = []

  sessionId = 'session-1'
  workspace: string | null = 'workspace-1'
  acceptResult = true
  /** 让 acceptUserMessage 挂在半途，用于观察「守卫失败时副作用已发生」。 */
  acceptGate: Promise<void> | null = null
  checkpointError: unknown = null

  private readonly chatSessionPort: import('./chatSessionPort').ChatSessionPort = {
    currentSessionId: () => this.currentSessionId(),
    workspaceGrantId: () => this.workspaceGrantId(),
    acceptUserMessage: message => this.acceptUserMessage(message),
    recordToolCalls: step => this.recordToolCalls(step),
    recordToolResult: result => this.recordToolResult(result),
    commitAssistantMessage: message => this.commitAssistantMessage(message),
    reviseAssistantMessage: message => this.reviseAssistantMessage(message),
    beginCheckpoint: (sessionId, messageId) => this.beginCheckpoint(sessionId, messageId),
    backupFile: (sessionId, checkpointId, path) => this.backupFile(sessionId, checkpointId, path),
    markCheckpointFiles: (sessionId, checkpointId) => this.markCheckpointFiles(sessionId, checkpointId),
    clearConversation: sessionId => this.clearConversation(sessionId),
  }

  /** 供 ConversationSessionPorts.session 使用的完整端口。 */
  asPort(): import('./chatSessionPort').ChatSessionPort { return this.chatSessionPort }

  currentSessionId(): string { return this.sessionId }
  workspaceGrantId(): string | null { return this.workspace }

  async acceptUserMessage(message: {
    sessionId: string
    messageId: string
    text: string
    images: ConversationImage[]
  }): Promise<boolean> {
    this.events.push(`accept:${message.messageId}`)
    this.accepted.push({ ...message, images: [...message.images] })
    if (this.acceptGate) await this.acceptGate
    return this.acceptResult
  }

  async beginCheckpoint(_sessionId: string, messageId: string): Promise<string> {
    this.events.push(`checkpoint:${messageId}`)
    if (this.checkpointError) throw this.checkpointError
    return messageId
  }

  async recordToolCalls(step: {
    sessionId: string
    stepId: string
    calls: readonly unknown[]
    visibleText?: string
  }): Promise<boolean> {
    this.events.push(`toolCalls:${step.stepId}`)
    this.recordedCalls.push({ ...step, calls: [...step.calls] })
    return true
  }

  async recordToolResult(result: {
    sessionId: string
    callId: string
    content: string
    status: 'succeeded' | 'failed' | 'rejected'
    code?: string
  }): Promise<boolean> {
    this.events.push(`toolResult:${result.callId}:${result.status}`)
    this.recordedResults.push({ ...result })
    return true
  }

  async commitAssistantMessage(message: CommitAssistantMessage): Promise<string | null> {
    this.events.push(`assistant:${message.source}`)
    this.assistantMessages.push(message)
    return `assistant-message-${this.assistantMessages.length}`
  }

  async reviseAssistantMessage(message: ReviseAssistantMessage): Promise<boolean> {
    this.events.push(`revise:${message.messageId}`)
    this.revisions.push(message)
    return true
  }

  async backupFile(_sessionId: string, _checkpointId: string, path: string): Promise<void> {
    this.events.push(`backup:${path}`)
  }

  async markCheckpointFiles(_sessionId: string, checkpointId: string): Promise<void> {
    this.events.push(`markCheckpoint:${checkpointId}`)
  }

  async clearConversation(sessionId: string): Promise<void> {
    this.events.push(`clear:${sessionId}`)
  }
}

export class FakeToolCatalog implements ConversationToolCatalog {
  readonly contexts: CharacterToolContext[] = []
  readonly extracted: string[] = []
  toolDefinitions: ToolDefinition[] = [
    { type: 'function', function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: {} } } },
  ]
  /** 文本兜底路径的提取结果；默认不识别任何文本调用。 */
  textToolCalls: ToolCall[] = []

  definitions(context: CharacterToolContext): ToolDefinition[] {
    this.contexts.push(context)
    return this.toolDefinitions
  }

  extractTextToolCalls(text: string): ToolCall[] {
    this.extracted.push(text)
    return this.textToolCalls
  }

  stripTextToolCalls(text: string): string { return text }
}

export class FakeToolExecutionPort implements ConversationToolExecutionPort {
  /** 网关默认沿用 5 分钟超时；要观察超时路径的测试可以传一个更短的。 */
  constructor(readonly gateway: ApprovalGateway = new ApprovalGateway()) {}

  readonly executed: ToolCall[] = []
  readonly checkpointed: string[] = []
  /** 每次策略调用收到的执行上下文；用于断言「本会话自动允许」是否生效。 */
  readonly contexts: ToolExecutionContext[] = []
  /** 每个工具名的脚本化结果；未登记即成功。 */
  readonly results = new Map<string, ToolResult>()
  /** 默认策略：无批准、无检查点。 */
  prepare: ToolExecutionPolicy['prepare'] = async call => ({ call })
  /** 最近一次 create 绑定的回合钩子。 */
  hooks: ConversationToolRoundHooks | null = null
  sessionApprovals = 0

  /** 与真适配器同形：把网关的待批准请求折叠成「待决与否」的布尔量。 */
  subscribeApproval(listener: ConversationApprovalListener): () => void {
    return this.gateway.subscribe(request => listener(request !== null))
  }

  create(round: ConversationToolRoundHooks): ToolExecutionCoordinator {
    this.hooks = round
    return new ToolExecutionCoordinator({
      approvalGateway: this.gateway,
      policy: {
        prepare: (call, context) => {
          this.contexts.push({ ...context })
          return this.prepare(call, context)
        },
      },
      execute: async call => {
        this.executed.push(call)
        return this.results.get(call.name)
          ?? { role: 'tool', tool_call_id: call.id, content: `${call.name} 完成`, ok: true }
      },
      checkpoint: async path => {
        this.checkpointed.push(path)
        await round.checkpoint(path)
      },
      onCheckpointError: round.onCheckpointError,
      onSessionApproval: () => {
        this.sessionApprovals++
        round.onSessionApproval?.()
      },
    })
  }
}

export class FakeVoicePort implements ConversationVoicePort {
  readonly played: ConversationVoiceRequest[] = []
  readonly cancelled: { reason: string; resetDedupe: boolean }[] = []

  play(request: ConversationVoiceRequest): void { this.played.push({ ...request }) }

  cancel(reason: string, resetDedupe = false): void {
    this.cancelled.push({ reason, resetDedupe })
  }
}

export class FakeNetworkProbe implements ConversationNetworkProbe {
  online = true
  isOnline(): boolean { return this.online }
}

/** 文案固定成可断言的标记，避免测试依赖真实语言包。 */
export const FAKE_TEXTS: ConversationTexts = {
  imageOnlyPrompt: () => '[仅图片]',
  networkOff: () => '[网络不可用]',
  apiNotConfigured: () => '[API 未配置]',
  error: msg => `[错误] ${msg}`,
  done: () => '[没有可交付的回复]',
}

// ─── 组合 ──────────────────────────────────────────────

export interface ConversationHarness {
  session: ConversationSession
  clock: FakeClock
  model: FakeModelClient
  translate: FakeTranslator
  character: FakeCharacterSource
  context: FakeModelContext
  facts: FakeChatSessionPort
  catalog: FakeToolCatalog
  toolExecution: FakeToolExecutionPort
  voice: FakeVoicePort
  network: FakeNetworkProbe
  texts: ConversationTexts
  ports: ConversationSessionPorts
}

/** 装配一套假端口并把它们接成 ConversationSession。 */
export function createConversationHarness(
  options: ConversationSessionOptions = {},
  overrides: Partial<ConversationSessionPorts> = {},
): ConversationHarness {
  const clock = new FakeClock()
  const model = new FakeModelClient()
  const translate = new FakeTranslator()
  const character = new FakeCharacterSource()
  const context = new FakeModelContext()
  const facts = new FakeChatSessionPort()
  const catalog = new FakeToolCatalog()
  const toolExecution = new FakeToolExecutionPort()
  const voice = new FakeVoicePort()
  const network = new FakeNetworkProbe()
  const texts = FAKE_TEXTS

  const ports: ConversationSessionPorts = {
    model,
    translate,
    character,
    context,
    session: facts.asPort(),
    tools: catalog,
    toolExecution,
    voice,
    clock,
    network,
    texts,
    ...overrides,
  }

  return {
    session: new ConversationSession(ports, options),
    clock,
    model,
    translate,
    character,
    context,
    facts,
    catalog,
    toolExecution,
    voice,
    network,
    texts,
    ports,
  }
}
