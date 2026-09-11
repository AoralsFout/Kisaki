/**
 * 组合根：显式安装所有跨模块服务与监听器，并构造对话切片的完整对象图。
 *
 * 各模块不再在加载时或自己的函数体里自行接线；启动流程只调用一次 composeApplication()，
 * 因此「谁被装配、装配了几次」可以从这一处读出来。
 *
 * 「启动时构建一次」不等于「在 composeApplication() 的这一刻构造」：该函数早于
 * main.ts 安装 Pinia，也早于凭据预热，因此
 *  - 依赖 Pinia store 的端口延迟到首次调用才解析（见 SessionStoreChatSessionPort）；
 *  - 会话持久化必须等主窗口调 init() 才发生（每个窗口都会执行本函数，只有主窗口
 *    该创建或载入会话文档），故以装配工厂的形式注入，见 assembleSessionService。
 */
import { createLogger } from './utils/logger'
import type { ApprovalGateway } from './application/tools/approvalGateway'
import type {
  ConversationSession,
  ConversationSessionPorts,
} from './application/conversation/conversationSession'
import type { SessionServiceAssembly, SessionServiceInputs } from './application/session/sessionServiceAssembly'
import type { ChatContextModelContext } from './infrastructure/conversation/chatContextModelContext'

const log = createLogger('Composition')

/** 批准请求的等待上限；与迁移前 `stores/chat.ts` 的常量同值。 */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 新路径的对象图：解析后的端口集合，以及由它构造出的回合编排器。
 * 端口集合是装配的唯一事实来源；外部只通过这里的 `session` 驱动回合。
 */
export interface ConversationAssembly {
  ports: ConversationSessionPorts
  session: ConversationSession
  /** 模型上下文端口实现；整体替换（清空对话、切换会话、配置变更）需要它端口之外的方法。 */
  context: ChatContextModelContext
  /**
   * 批准网关；组合根持有，回合只经工具执行端口拿到「有没有待批准请求」这个布尔量。
   * 待批准请求本身与用户的决策仍走网关自己的订阅，展示层需要它来渲染批准卡。
   */
  approvalGateway: ApprovalGateway
}

/** 逐端口替换入口：缺省全部用真机适配器，测试用它把某条缝换成假实现。 */
export type ConversationPortOverrides = Partial<Omit<ConversationSessionPorts, 'context'>> & {
  /** 上下文只接受具体适配器：对象图对外还要暴露它端口之外的整体替换方法。 */
  context?: ChatContextModelContext
}

let composed = false
let conversation: ConversationAssembly | null = null

/**
 * 装配对话切片的完整对象图。
 *
 * 用动态 import 取适配器，与既有的 installer 安装同一风格：组合根本身不把适配器链拉进首帧。
 * 端口缺一即由 ConversationSession 构造失败，不会静默空转。
 */
export async function composeConversationAssembly(
  overrides: ConversationPortOverrides = {},
): Promise<ConversationAssembly> {
  const [
    { ConversationSession },
    { SystemConversationClock },
    { BrowserNetworkProbe },
    { AiConversationTranslator },
    { ChatContextModelContext },
    { AiModelClient },
    { CharacterStoreSource },
    { TtsOrchestratorVoicePort },
    { ttsPlaybackOrchestrator },
    { AgentServiceToolCatalog },
    { I18nConversationTexts },
    { ToolExecutionCoordinatorFactory },
    { ApprovalGateway },
    { SessionStoreChatSessionPort },
  ] = await Promise.all([
    import('./application/conversation/conversationSession'),
    import('./infrastructure/conversation/systemConversationClock'),
    import('./infrastructure/conversation/browserNetworkProbe'),
    import('./infrastructure/conversation/aiConversationTranslator'),
    import('./infrastructure/conversation/chatContextModelContext'),
    import('./infrastructure/conversation/aiModelClient'),
    import('./infrastructure/conversation/characterStoreSource'),
    import('./infrastructure/conversation/ttsOrchestratorVoicePort'),
    import('./tts/orchestrator'),
    import('./infrastructure/conversation/agentToolCatalog'),
    import('./infrastructure/conversation/i18nConversationTexts'),
    import('./infrastructure/conversation/toolExecutionCoordinatorFactory'),
    import('./application/tools/approvalGateway'),
    import('./infrastructure/conversation/sessionStoreChatSessionPort'),
  ])

  const context = overrides.context ?? new ChatContextModelContext()
  // 批准网关由组合根持有；回合只经工具执行端口的 subscribeApproval 拿到待决布尔量，
  // 待批准请求的值仍归网关自己的订阅。超时按既有语义自动拒绝。
  const approvalGateway = new ApprovalGateway(CONFIRM_TIMEOUT_MS, request => {
    log.warn('composition.approval_timeout', `工具批准超时，自动拒绝: ${request.toolName}`, undefined, {
      tool_name: request.toolName,
      approval_kind: request.kind,
      confirm_timeout_ms: CONFIRM_TIMEOUT_MS,
    })
  })

  const ports: ConversationSessionPorts = {
    model: overrides.model ?? new AiModelClient(),
    translate: overrides.translate ?? new AiConversationTranslator(),
    character: overrides.character ?? new CharacterStoreSource(),
    context,
    session: overrides.session ?? new SessionStoreChatSessionPort(),
    tools: overrides.tools ?? new AgentServiceToolCatalog(),
    toolExecution: overrides.toolExecution ?? new ToolExecutionCoordinatorFactory(approvalGateway),
    voice: overrides.voice ?? new TtsOrchestratorVoicePort(ttsPlaybackOrchestrator),
    clock: overrides.clock ?? new SystemConversationClock(),
    network: overrides.network ?? new BrowserNetworkProbe(),
    texts: overrides.texts ?? new I18nConversationTexts(),
  }

  return { ports, session: new ConversationSession(ports), context, approvalGateway }
}

/** 组合根装配出的对话对象图；composeApplication() 尚未跑过时显式失败。 */
export function conversationAssembly(): ConversationAssembly {
  if (!conversation) throw new Error('组合根尚未装配对话回合：composeApplication() 未执行')
  return conversation
}

/**
 * 装配会话服务：真机 Tauri 仓储优先，不可用时降级为易失的内存仓储。
 *
 * 适配器选择声明在组合根，SessionStore 只消费结果 —— 它不再知道有几种仓储实现。
 * 降级与否要等 initialize() 真正读过文件才知道（浏览器预览没有 Tauri 命令通道、
 * v2 文件损坏都在这时暴露），因此这里保留与迁移前逐字相同的 try/catch 顺序。
 */
export async function assembleSessionService(inputs: SessionServiceInputs): Promise<SessionServiceAssembly> {
  const [
    { SessionApplicationService },
    { TauriSessionRepository },
    { MemorySessionRepository },
  ] = await Promise.all([
    import('./application/session/sessionApplicationService'),
    import('./infrastructure/session/tauriSessionRepository'),
    import('./infrastructure/session/memorySessionRepository'),
  ])

  const service = new SessionApplicationService({
    repository: new TauriSessionRepository(),
    now: inputs.now,
    nextId: inputs.nextId,
  })
  try {
    await service.initialize('新对话')
    return { service, degraded: false }
  } catch (error) {
    // 浏览器预览没有 Tauri 命令通道。此处保留易失的 v2 文档；
    // 绝不读取或改写旧版会话格式。
    log.warn('session.persistence_unavailable', '会话文件接口不可用，使用内存会话', error)
    const fallback = new SessionApplicationService({
      repository: new MemorySessionRepository(),
      now: inputs.now,
      nextId: inputs.nextId,
    })
    await fallback.initialize('新对话')
    return { service: fallback, degraded: true }
  }
}

/** 幂等：重复调用（热更新、多入口）不会叠加监听器。 */
export async function composeApplication(): Promise<void> {
  if (composed) return
  composed = true

  const [
    { initTools },
    { installLocalSettingsBridge },
    { installMotionPreferenceSync },
    { installTtsPlaybackTelemetry },
    { setChatSessionPort, setChatCharacterIdentity },
    { setSessionServiceFactory },
    { SessionStoreChatSessionPort },
    { useCharacterStore },
  ] = await Promise.all([
    import('./agent'),
    import('./infrastructure/settings/localSettingsStore'),
    import('./utils/motionPreference'),
    import('./tts/orchestrator'),
    import('./stores/chat'),
    import('./stores/session'),
    import('./infrastructure/conversation/sessionStoreChatSessionPort'),
    import('./stores/character'),
  ])

  initTools()
  installLocalSettingsBridge()
  installMotionPreferenceSync()
  installTtsPlaybackTelemetry()

  // 会话事实端口：组合根是唯一的注入点；端口自己延迟解析 SessionStore。
  setChatSessionPort(new SessionStoreChatSessionPort())
  // 会话持久化的选择：真机优先、内存兜底，SessionStore 只消费装配结果。
  setSessionServiceFactory(assembleSessionService)
  // 角色身份来源：assistant 消息落库时记录 { id, name } 快照。
  setChatCharacterIdentity(() => {
    const character = useCharacterStore()
    return character.data ? { id: character.currentId, name: character.name } : null
  })

  conversation = await composeConversationAssembly()

  log.debug('composition.ready.debug', '应用组合完成')
}
