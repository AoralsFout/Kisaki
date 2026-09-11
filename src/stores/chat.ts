/**
 * 对话状态管理（Pinia）
 *
 * 本 store 只做两件事：订阅 `ConversationSession` 的投影并写进自己的响应式状态，
 * 把用户动作转发为 `send` / `cancel`。回合的守卫、编排、取消与终态分类都在
 * `src/application/conversation/conversationSession.ts` —— 这里不再持有任何被闭包
 * 共享改写的回合级绑定，也不再从函数体里现场读取环境依赖。
 *
 * 状态按来源分三层，改动时不要越界：
 *  1. 投影派生 —— 回合计状态、气泡文本与思考、输入态、工具活动、上下文统计、
 *     本会话自动允许。它们的唯一写入点是 `applyProjection`。
 *  2. 界面自有 —— 输入框开合、气泡显隐、工具活动列表的淡出计时、界面消息列表。
 *     前两者是纯界面开关，不进投影；`messages` 的 id 必须与会话事实一致，
 *     由 `subscribeMessages` 的已提交消息事件维护。
 *  3. 只读转发 —— 批准网关由组合根持有，store 只订阅待决请求、转发用户决策。
 *
 * 调试日志沿用本仓库的分级惯例：trace 记函数出入口，debug 记状态变更，
 * 回合内部的细粒度日志已随编排一起搬到 ConversationSession。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { isConfigValid, loadConfig } from '../ai'
import type { ChatContextInspection, ChatContextSnapshot, ChatInputPayload, ContextStats, ImageAttachment } from '../ai'
import type { ToolDefinition } from '../agent'
import { SAY_TOOL_NAME } from '../agent/tools/say'
import { conversationAssembly, type ConversationAssembly } from '../compositionRoot'
import { assembleRoundToolList } from '../application/conversation/roundToolList'
import type { ApprovalDecision, ApprovalRequest } from '../application/tools/approvalGateway'
import {
  isConversationRunActive,
  isConversationRunUsingTools,
  type ConversationRunState,
} from '../application/conversation/conversationRun'
import type {
  ConversationMessageEvent,
  ConversationProjection,
  ConversationToolActivity,
} from '../application/conversation/conversationSession'
import { createLogger } from '../utils/logger'

const log = createLogger('ChatStore')

/** 工具活动列表淡出前的保留时长（有调用时留一会儿供用户回看）。 */
const TOOL_ACTIVITY_FADE_MS = 5000

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

/** 工具调用活动（主窗口右侧列表用，临时态，不持久化）。 */
export type ToolActivity = ConversationToolActivity

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

/** 角色身份来源：由组合根注入（避免 store 直接依赖 Pinia 角色状态） */
let characterIdentity: (() => { id: string; name: string } | null) | null = null

/** 由组合根注入角色身份读取函数；assistant 消息落库时记录身份快照。 */
export function setChatCharacterIdentity(getter: () => { id: string; name: string } | null): void {
  characterIdentity = getter
}

export const useChatStore = defineStore('chat', () => {
  // ── 投影派生：唯一写入点是 applyProjection ─────────────
  /** 回合计状态。 */
  const conversationRunState = ref<ConversationRunState>('idle')
  /** 是否有进行中的回合（由回合计状态派生，不再另有真相来源）。 */
  const isProcessing = ref(false)
  /** 是否正在等待批准或执行工具（由回合计状态派生）。 */
  const isUsingTools = ref(false)
  /** 气泡文本（含流式中间态）。 */
  const currentBubbleText = ref('')
  /** 思考过程文本。 */
  const currentThinking = ref('')
  /** 气泡正在追加文本。 */
  const isTyping = ref(false)
  /** 上下文统计。 */
  const contextStats = ref<ContextStats>({
    estimatedTokens: 0,
    maxContextTokens: 0,
    toolDefinitionTokens: 0,
    messageCount: 0,
    summarizedRounds: 0,
    prunedMessages: 0,
    utilization: 0,
  })
  /** 本回合的工具活动，按发生顺序排列（临时态，不持久化）。 */
  const toolActivities = ref<ToolActivity[]>([])
  /** 本会话内已允许自动执行后续文件操作。 */
  const autoExecSession = ref(false)
  /** 待用户决定的批准请求；来自组合根持有的批准网关。 */
  const pendingApproval = ref<ApprovalRequest | null>(null)

  // ── 界面自有：不进投影 ────────────────────────────────
  /** 界面消息列表；不在投影里，由已提交消息事件维护。 */
  const messages = ref<ChatMessage[]>([])
  /** 气泡是否显示。 */
  const showBubble = ref(false)
  /** 输入框是否展开。 */
  const showInput = ref(false)
  /** 是否显示工具活动列表（处理时点亮，完成后延时淡出）。 */
  const showToolActivity = ref(false)
  /** 模型配置是否齐备（设置页与输入框提示用）。 */
  const configReady = ref(false)

  /** 当前角色人设；整体替换模型上下文之后由 store 按它重新套用。 */
  let currentPersona: {
    prompt: string
    voiceLang?: string
    displayLang?: string
    render?: 'illustration' | 'live2d'
  } | null = null
  /** 工具活动列表淡出延时器。 */
  let toolHideTimer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次投影里的工具活动 id，用来判断是否有新活动出现。 */
  let knownActivityIds: string[] = []
  /** 投影、消息与批准订阅的退订函数；装配一次之后长期有效。 */
  let unsubscribes: (() => void)[] = []

  /**
   * 组合根装配出的对话对象图；首次取用时建立三条订阅。
   *
   * 订阅推迟到真正需要回合状态的那一刻：界面组件可能早于装配被挂载，
   * 而此刻缺装配会由 conversationAssembly() 显式抛错，而不是静默空转。
   */
  function conversation(): ConversationAssembly {
    const assembly = conversationAssembly()
    if (unsubscribes.length === 0) {
      unsubscribes = [
        assembly.session.subscribe(applyProjection),
        assembly.session.subscribeMessages(applyMessageEvent),
        assembly.approvalGateway.subscribe(request => { pendingApproval.value = request }),
      ]
    }
    return assembly
  }

  /**
   * 把投影写进响应式状态。
   *
   * `isProcessing` / `isUsingTools` 是派生量：它们的唯一写入点就是这里，
   * 不随回合实现变化而增多 —— 回合计状态一变，两者跟着变。
   *
   * 投影里的 `runId` / `revision` 只供订阅者判断投影是否真的前进过，
   * 界面没有消费者，因此不落到响应式状态。
   */
  function applyProjection(projection: ConversationProjection): void {
    conversationRunState.value = projection.runState
    isProcessing.value = isConversationRunActive(projection.runState)
    isUsingTools.value = isConversationRunUsingTools(projection.runState)
    currentBubbleText.value = projection.bubbleText
    isTyping.value = projection.typing
    currentThinking.value = projection.thinking
    contextStats.value = projection.context
    autoExecSession.value = projection.autoExecSession
    applyToolActivities(projection.toolActivities, projection.runState)
  }

  /**
   * 工具活动列表：新活动出现时点亮并取消待淡出计时。
   *
   * 淡出只在回合**自然结束**（completed / failed）时重新计时，与迁移前一致：
   * 被取消或被新回合顶替的列表留在原位，不重新计时，也不被旧回合改写。
   */
  function applyToolActivities(
    activities: readonly ConversationToolActivity[],
    state: ConversationRunState,
  ): void {
    const appeared = activities.some(activity => !knownActivityIds.includes(activity.id))
    knownActivityIds = activities.map(activity => activity.id)
    toolActivities.value = activities.map(activity => ({ ...activity }))

    if (appeared) {
      if (toolHideTimer !== null) { clearTimeout(toolHideTimer); toolHideTimer = null }
      showToolActivity.value = true
      return
    }
    if (activities.length === 0) {
      if (toolHideTimer !== null) { clearTimeout(toolHideTimer); toolHideTimer = null }
      showToolActivity.value = false
      return
    }
    if ((state === 'completed' || state === 'failed') && toolHideTimer === null) {
      toolHideTimer = setTimeout(() => {
        showToolActivity.value = false
        toolHideTimer = null
      }, TOOL_ACTIVITY_FADE_MS)
    }
  }

  /** 已提交 / 已修订的消息事实 → 界面消息列表。 */
  function applyMessageEvent(event: ConversationMessageEvent): void {
    if (event.type === 'user-accepted') {
      addMessage('user', event.text, undefined, undefined, [...event.images], event.messageId)
      return
    }
    if (event.type === 'assistant-committed') {
      addMessage('assistant', event.display, event.thinking, event.voice, undefined, event.messageId)
      return
    }
    // 语音在后台补齐后回填：列表里找不到这条消息就不回填（它可能已被清空或换走）。
    const message = messages.value.find(item => item.id === event.messageId)
    if (!message) return
    if (event.voice !== undefined) message.voice = event.voice
    if (event.display !== undefined) message.text = event.display
  }

  /** 上下文被整体替换过之后投影不会自己前进，手动重读一次。 */
  function refreshProjection(): void {
    applyProjection(conversation().session.projection())
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

    log.trace("chat_store.add_message.trace", `[${_fn}] ▶ role=${role} text=${text.length}字 thinking=${thinking?.length || 0}字`, { fn: _fn, role: role, text_length: text.length })
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
    return id
  }

  function init() {
    log.trace("chat_store.init.trace", "[init] ▶")
    const cfg = loadConfig()
    const valid = isConfigValid(cfg)
    configReady.value = valid
    // 建立投影订阅：启动时就写一次真实投影，界面不必等第一个回合。
    conversation()
    log.info("chat_store.init.info", `[init] ChatStore 初始化, 配置${valid ? '' : '未'}就绪`, { valid: valid ? '' : '未' })
    log.trace("chat_store.init.trace", "[init] ◀")
  }

  /**
   * 发送消息给 AI。
   *
   * 返回值沿用迁移前的语义：取消、以及「有工具失败但仍交付了回复」都算已接受，
   * 只有守卫拒绝、执行期失败与触达轮次上限返回 false（App 据此决定是否重新弹出输入框）。
   */
  async function sendMessage(input: string | ChatInputPayload): Promise<boolean> {
    const _fn = 'sendMessage'
    const rawText = typeof input === 'string' ? input : input.text
    const images = typeof input === 'string' ? [] : input.images
    log.trace("chat_store.send_message.trace", `[${_fn}] ▶ text=${rawText?.length ?? 0} 字符, images=${images.length}`, { fn: _fn, raw_text_length: rawText?.length ?? 0, images_length: images.length })

    // 气泡显隐是界面自有状态：重入与空消息守卫拒绝时保持原样，其余路径一律点亮。
    if (!isProcessing.value && ((rawText || '').trim() || images.length > 0)) showBubble.value = true
    const result = await conversation().session.send({ text: rawText ?? '', images })
    log.debug("chat_store.send_message.debug", `[${_fn}] ◀ status=${result.status} turns=${result.turnsUsed}`, { fn: _fn, status: result.status, turns_used: result.turnsUsed })
    return result.status === 'success' || result.status === 'cancelled'
  }

  /**
   * 用户主动停止一次回复。
   *
   * 「本会话自动允许」的授予不因它撤销 —— 那是回合计状态机的语义，
   * store 不再自己判断，只转发一条取消。
   */
  function cancelResponse() {
    const _fn = 'cancelResponse'
    log.trace("chat_store.cancel_response.trace", `[${_fn}] ▶ run=${conversationRunState.value}`, { fn: _fn, run_state: conversationRunState.value })
    conversation().session.cancel('user-cancelled')
    showBubble.value = false
    log.info("chat_store.cancel_response.info", `[${_fn}] ✓ AI 回复已取消`, { fn: _fn })
  }

  /** 清空当前对话：终止回合、清空界面列表与模型上下文，并抹掉会话事实。 */
  function clearMessages() {
    const _fn = 'clearMessages'
    const prevCount = messages.value.length
    log.trace("chat_store.clear_messages.trace", `[${_fn}] ▶ (当前消息数=${prevCount})`, { fn: _fn, prev_count: prevCount })

    const { session, context, ports } = conversation()
    // 取消同时收口回合、后台语音与「本会话自动允许」。
    session.cancel('messages-cleared')
    rejectPendingApproval()
    hideBubble()
    messages.value = []
    // 模型上下文整体换一个新的（等价于迁移前的 chatContext = createChatContext()）。
    context.reset()
    currentPersona = null
    refreshProjection()

    // 会话事实与检查点由 Session Aggregate 一次性清空。
    void ports.session.clearConversation(ports.session.currentSessionId())
    log.info("chat_store.clear_messages.info", `[${_fn}] ✓ 已清空 ${prevCount} 条聊天记录`, { fn: _fn, prev_count: prevCount })
  }

  /**
   * 角色切换后按新角色重建模型上下文。
   *
   * 与迁移前的差异：角色切换现在经会话的取消入口**干净地终止进行中的回合**，
   * 而不是只取消后台语音与播放、任由旧回合继续往气泡里写。这是本次 PR 仅有的
   * 两处用户可见行为变更中的第一处（第二处是 `refreshModelContext`），均已获批准。
   */
  function resetContext() {
    const _fn = 'resetContext'
    log.trace("chat_store.reset_context.trace", `[${_fn}] ▶ run=${conversationRunState.value}`, { fn: _fn, run_state: conversationRunState.value })
    const { session, context } = conversation()
    session.cancel('context-reset')
    hideBubble()
    context.reset()
    currentPersona = null
    refreshProjection()
    log.debug("chat_store.reset_context.debug", `[${_fn}] ✓ 对话上下文已重置`, { fn: _fn })
  }

  /**
   * 加载历史消息（会话切换、回档或恢复历史时使用）。
   * 保留 system prompt，清除当前消息并用历史消息重建模型上下文。
   */
  function loadMessages(msgs: ChatMessage[], snapshot?: ChatContextSnapshot | null) {
    const _fn = 'loadMessages'
    log.trace("chat_store.load_messages.trace", `[${_fn}] ▶ msgs.length=${msgs.length}`, { fn: _fn, msgs_length: msgs.length })

    const { session, context } = conversation()
    // 切换、回档或恢复历史时，旧回复的后台语音不得继续写回或播放。
    session.cancel('session-changed')

    const userCount = msgs.filter(m => m.role === 'user').length
    const asstCount = msgs.filter(m => m.role === 'assistant').length
    messages.value = [...msgs]

    // 重置气泡与输入态；「本会话自动允许」已随取消撤销。
    hideBubble()
    showInput.value = false
    rejectPendingApproval()

    context.reset()
    if (snapshot && context.restore(snapshot)) {
      context.restoreUserImages(msgs
        .filter(msg => msg.role === 'user')
        .map(msg => ({ text: msg.text, images: msg.images })))
      log.info("chat_store.load_messages.info", `[${_fn}] ✓ 已恢复持久化协议上下文（${snapshot.messages.length} 条）`, { fn: _fn, snapshot_messages: snapshot.messages.length })
    } else {
      // 旧会话兼容：重放界面消息到模型上下文。
      // 关键：助手回合必须重建为 say 工具调用（而非纯文本）。否则恢复出的历史会呈现
      // “助手只用纯文本回复、从不调用工具”的范式，模型会模仿它而忘记调用 say/动作工具
      // （会话切走再切回后表现为“忘记使用工具”）。
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        if (msg.role === 'user') {
          context.addUserMessage(msg.text, msg.images ?? [])
          log.trace("chat_store.load_messages.trace", `[${_fn}]   [${i + 1}/${msgs.length}] user → context (${msg.text.length}字)`, { fn: _fn, i: i + 1, msgs_length: msgs.length, text_length: msg.text.length })
        } else if (msg.role === 'assistant') {
          // 重建为 say 调用：voice 取持久化的母语台词（旧会话缺失则回退显示文本）
          const sayId = `say_replay_${i}`
          context.addToolCalls([{
            id: sayId,
            type: 'function',
            function: {
              name: SAY_TOOL_NAME,
              arguments: JSON.stringify({ voice: msg.voice || msg.text, display: msg.text }),
            },
          }])
          context.addToolResult(sayId, '已说出')
          log.trace("chat_store.load_messages.trace", `[${_fn}]   [${i + 1}/${msgs.length}] assistant → say 调用重建 (${msg.text.length}字)`, { fn: _fn, i: i + 1, msgs_length: msgs.length, text_length: msg.text.length })
        }
      }
      log.debug("chat_store.load_messages.debug", `[${_fn}] ✓ 旧会话消息重放完成（助手回合已重建为 say 调用）`, { fn: _fn })
    }

    refreshProjection()

    // 会话切换后，气泡显示目标会话的最后一条 AI 消息（含思考过程）
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
    if (lastAssistant) {
      currentThinking.value = lastAssistant.thinking || ''
      showBubbleText(lastAssistant.text, false)
    }
    log.info("chat_store.load_messages.info", `[${_fn}] ✓ 已加载会话消息：${msgs.length} 条 (user=${userCount} asst=${asstCount})`, { fn: _fn, msgs_length: msgs.length, user_count: userCount, asst_count: asstCount })
  }

  /** 更新角色 system prompt（含语言配置）。 */
  function setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string, render?: 'illustration' | 'live2d') {
    const _fn = 'setSystemPrompt'
    log.trace("chat_store.set_system_prompt.trace", `[${_fn}] ▶ prompt=${prompt?.length || 0}字 voiceLang=${voiceLang || '?'} displayLang=${displayLang || '?'}`, { fn: _fn, prompt_length: prompt?.length || 0, voice_lang: voiceLang || '?', display_lang: displayLang || '?' })
    log.sensitiveDebug("chat_store.system_prompt_sensitive.debug", `[${_fn}] prompt片段`, { fn: _fn, prompt_slice: (prompt || '').slice(0, 50) })
    currentPersona = { prompt, voiceLang, displayLang, render }
    conversation().context.setSystemPrompt(prompt, voiceLang, displayLang, render)
    refreshProjection()
  }

  /**
   * API 模型变更后按新预算重建上下文，保留当前脱敏协议上下文与角色人格。
   *
   * 与迁移前的差异：迁移前这里**既不终止进行中的回合，也不隐藏气泡**，也不作废
   * 后台语音 —— 上下文换新之后，旧回合仍会继续往气泡里写，用户看到的是新预算下的
   * 界面配着旧回合的输出。这是「后台语音不得越过自己的回合」的第 6 条隐式路径。
   * 现在它与其它触发一样走会话的取消入口：`session.cancel('model-context-refreshed')`
   * 终止回合，`hideBubble()` 收起气泡。
   *
   * 这是本次 PR **仅有的两处用户可见行为变更中的第二处**（第一处是角色切换，见
   * `resetContext`），两处均已获用户批准。
   */
  function refreshModelContext() {
    const { session, context } = conversation()
    session.cancel('model-context-refreshed')
    hideBubble()

    const snapshot = context.snapshot()
    context.reset()
    if (currentPersona) {
      context.setSystemPrompt(
        currentPersona.prompt,
        currentPersona.voiceLang,
        currentPersona.displayLang,
        currentPersona.render,
      )
    }
    context.restore(snapshot)
    context.restoreUserImages(messages.value
      .filter(msg => msg.role === 'user')
      .map(msg => ({ text: msg.text, images: msg.images })))
    configReady.value = isConfigValid(loadConfig())
    refreshProjection()
    log.info("chat_store.refresh_model_context.info", `模型配置已刷新，上下文预算=${contextStats.value.maxContextTokens}`, { context_stats_value: contextStats.value.maxContextTokens })
  }

  function exportContext(): ChatContextSnapshot {
    return conversation().context.snapshot()
  }

  /**
   * 返回下一次模型请求可见的完整上下文视图。
   * 不写入磁盘，不含 API Key；图片只保留 MIME 与体积说明。
   */
  function inspectContext(): CurrentContextInspection {
    const { context, ports } = conversation()
    const character = ports.character.state()
    // 与回合同一套装配逻辑（同一个函数，不是抄一份）：设置页看到的清单就是回合实际发送的清单。
    const tools: ToolDefinition[] = assembleRoundToolList(
      ports.tools,
      character,
      Boolean(ports.session.workspaceGrantId()),
    )
    const config = loadConfig()
    return {
      ...context.inspect(tools),
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

  function resolveApproval(decision: ApprovalDecision): boolean {
    return conversation().approvalGateway.resolve(decision)
  }

  function rejectPendingApproval(): void {
    conversation().approvalGateway.rejectPending()
  }

  function showBubbleText(text: string, typing: boolean = true) {
    log.trace("chat_store.show_bubble_text.trace", `[showBubbleText] text=${text.length}字 typing=${typing}`, { text_length: text.length, typing: typing })
    log.sensitiveDebug("chat_store.bubble_text_sensitive.debug", '气泡文本片段', { text_slice: text.slice(0, 50) })
    currentBubbleText.value = text
    isTyping.value = typing
    showBubble.value = true
  }

  function hideBubble() {
    log.trace("chat_store.hide_bubble.trace", `[hideBubble] ▶ (当前文本=${currentBubbleText.value.length}字)`, { current_bubble_text_value: currentBubbleText.value.length })
    currentBubbleText.value = ""
    isTyping.value = false
    showBubble.value = false
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
