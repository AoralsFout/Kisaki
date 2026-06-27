/**
 * 对话上下文管理
 *
 * 维护多轮对话历史，自动裁剪超出长度的消息。
 * 支持 tool calls / tool results 消息（用于 Function Calling）。
 *
 * 现在支持按模型能力自动配置上下文预算与对话轮数：
 * 传入 model 名称 → 从 ModelProfile 推导合适值；
 * 不传则退化为原有保守默认值。
 */
import type { ChatMessage } from './types'
import { getDefaultMessages } from './prompts'
import { getContextLimit, getMaxRounds } from './modelCapabilities'
import { langName } from './langNames'
import { createLogger } from '../utils/logger'

const log = createLogger('ChatContext')

/**
 * 后备默认值（仅在未传 model 且未手动指定时使用）。
 * 按已知最保守模型（~GPT-3.5）设定，确保任何模型都能运行。
 */
const FALLBACK_MAX_ROUNDS = 10
const FALLBACK_MAX_CONTEXT_TOKENS = 6000

/** 单条工具结果最大字符数（超出部分截断） */
const MAX_TOOL_RESULT_LENGTH = 1000

/** CJK 字符正则 */
const CJK_RE = /[一-鿿぀-ゟ゠-ヿ가-힯]/

/**
 * 粗略估算文本 token 数（混合 CJK/ASCII 场景）
 *
 * 精确值因 tokenizer 而异，此处用于裁剪决策的排序比较而非计量。
 * CJK → 1.5t/字、ASCII → 0.35t/字符、空白 → 0.2t，外加 4t 消息结构开销。
 */
function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    if (char === ' ' || char === '\n' || char === '\t') {
      tokens += 0.2
    } else if (CJK_RE.test(char)) {
      tokens += 1.5
    } else {
      tokens += 0.35
    }
  }
  return Math.ceil(tokens) + 4 // 消息结构 overhead
}

/**
 * 构建说话方式指令（say 工具）
 * @param voiceLang 角色语音语言（TTS 合成用），如 "ja-JP"
 * @param displayLang 用户显示语言，如 "zh-CN"
 */
function buildLangInstruction(voiceLang: string, displayLang: string): string {
  const voiceLangName = langName(voiceLang)
  const displayLangName = langName(displayLang)

  if (voiceLang === displayLang) {
    return `\n\n## 🗣 说话方式（必须遵守）
你的母语是 ${voiceLangName}。你**只能通过调用 say 工具来说话**：把要说的话放进 say 的 voice 参数（${voiceLangName}，纯口语、可被语音合成，不含 emoji/动作描写）。母语与显示语言相同，display 可省略。`
  }

  return `\n\n## 🗣 说话方式（必须遵守）

你的母语是 ${voiceLangName}，但用户使用 ${displayLangName}。

你**只能通过调用 say 工具来说话**，每次开口都要调用它，并同时给出两个参数：
1. voice：用你的母语（${voiceLangName}）说出的台词，用于语音合成。必须是纯口语化的自然语言，不含 emoji、颜文字、特殊符号，也不含对动作或心理的描写。
2. display：把同一句话翻译成 ${displayLangName}，用于屏幕显示。

即使你同时切换了表情/姿势/服装，最后也要调用 say 把话说出来。`
}

/** 为每轮生成的简短说话提醒（利用近因偏差） */
function buildTurnReminder(voiceLang: string, displayLang: string): string {
  if (voiceLang === displayLang) {
    return `[提醒] 通过调用 say 工具说话（voice=台词）。`
  }
  return `[提醒] 通过调用 say 工具说话：voice=${langName(voiceLang)}台词，display=${langName(displayLang)}译文，两者都要给。`
}

/** 工具使用说明（按渲染类型生成，自动追加到所有角色提示词末尾） */
function buildToolInstructions(render: 'illustration' | 'live2d' = 'illustration'): string {
  const head = `
## 🔧 函数调用规则（必须遵守）
你只能通过函数调用与世界交互：**说话用 say**，改变状态用相应函数。普通正文不会改变你的任何状态；要让用户听到并看到你说的话，必须调用 say。

### 你必须使用函数调用的场景
1. 你要开口说任何话时 → 必须调用 say（这是唯一的说话方式）
2. 用户询问时间/天气/计算结果时 → 必须调用 get_time / get_weather / calculator；涉及实时、最新或你不确定的信息（新闻、价格、版本、近期事件）→ 必须调用 web_search 联网查证并标注来源`

  const illustration = `
3. 用户要求你改变外观时 → 必须调用 set_character_* 相关函数
4. 你的情绪发生变化时 → 调用 set_character_emotion
5. 你希望改变姿势或服装时 → 调用 set_character_stance / set_character_costume
6. 你需要改变你在屏幕的大小或位置时 → 调用 set_screen_pose

### 可用函数列表
- say(voice, display): 说出你的台词（唯一的说话方式）
- set_character_emotion(emotion): 切换表情
- set_character_stance(stance): 切换身体姿势
- set_character_costume(costume): 切换服装
- set_character_look(stance?, emotion?, costume?): 一步设置多项
- set_screen_pose(pose): 控制屏幕位置和大小
- get_character_state(): 查询你当前的状态
- get_time(timezone?): 获取当前时间
- get_weather(city, days?): 查询天气
- calculator(expression): 数学计算
- web_search(query, count?, time_range?): 联网搜索实时信息（带来源链接）`

  const live2d = `
3. 你的情绪/表情变化时 → 调用 set_expression
4. 你想做一个动作（招手、点头等）时 → 调用 play_motion
5. 你需要改变你在屏幕的大小或位置时 → 调用 set_screen_pose

### 可用函数列表（你是 Live2D 角色，没有立绘换装/姿势能力）
- say(voice, display): 说出你的台词（唯一的说话方式）
- set_expression(expression): 切换表情
- play_motion(motion, index?): 播放一个动作动画
- set_screen_pose(pose): 控制屏幕位置和大小
- get_character_state(): 查询你当前的状态
- get_time(timezone?): 获取当前时间
- get_weather(city, days?): 查询天气
- calculator(expression): 数学计算
- web_search(query, count?, time_range?): 联网搜索实时信息（带来源链接）`

  return head + (render === 'live2d' ? live2d : illustration)
}

/** 对话上下文管理器 */
export class ChatContext {
  private messages: ChatMessage[] = []
  private maxRounds: number
  private customPrompt: string | null = null
  private voiceLang: string = ''
  private displayLang: string = ''
  private render: 'illustration' | 'live2d' = 'illustration'
  private maxContextTokens: number

  /**
   * @param opts          可选配置对象
   * @param opts.model    模型名称——传入后自动按模型能力选择上下文预算和轮数
   * @param opts.maxRounds    手动覆写最大轮数（优先级高于 model 推导）
   * @param opts.maxContextTokens  手动覆写 token 上限（优先级高于 model 推导）
   *
   * 兼容旧式调用：new ChatContext(10, 6000) 仍可工作。
   */
  constructor(...args: any[]) {
    // 兼容旧式 positional args: (maxRounds, maxContextTokens)
    if (args.length <= 1 && typeof args[0] === 'object' && args[0] !== null) {
      const opts = args[0] as { model?: string; maxRounds?: number; maxContextTokens?: number }
      if (opts.model) {
        this.maxRounds = opts.maxRounds ?? getMaxRounds(opts.model)
        this.maxContextTokens = opts.maxContextTokens ?? getContextLimit(opts.model)
      } else {
        this.maxRounds = opts.maxRounds ?? FALLBACK_MAX_ROUNDS
        this.maxContextTokens = opts.maxContextTokens ?? FALLBACK_MAX_CONTEXT_TOKENS
      }
    } else {
      // 旧式调用
      this.maxRounds = (typeof args[0] === 'number' ? args[0] : FALLBACK_MAX_ROUNDS)
      this.maxContextTokens = (typeof args[1] === 'number' ? args[1] : FALLBACK_MAX_CONTEXT_TOKENS)
    }
    log.info('ChatContext 初始化: maxRounds=%d, maxContextTokens=%d', this.maxRounds, this.maxContextTokens)
    this.reset()
  }

  /** 当前上下文估计 token 总数（用于裁剪决策） */
  get estimatedTokens(): number {
    return this.messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0)
  }

  /** 重建 system prompt（应用语言指令变更） */
  private rebuildSystemPrompt() {
    if (!this.customPrompt || !this.voiceLang || !this.displayLang) return
    this.messages[0] = {
      role: 'system',
      content: this.customPrompt + buildLangInstruction(this.voiceLang, this.displayLang) + buildToolInstructions(this.render),
    }
    log.debug('System prompt 已重建 (语音: %s, 显示: %s)', this.voiceLang, this.displayLang)
  }

  /** 设置自定义 system prompt（自动追加语言指令和工具说明） */
  setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string, render?: 'illustration' | 'live2d') {
    this.customPrompt = prompt
    this.voiceLang = voiceLang || ''
    this.displayLang = displayLang || ''
    this.render = render ?? 'illustration'
    const langInstruction = voiceLang && displayLang ? buildLangInstruction(voiceLang, displayLang) : ''
    this.messages[0] = {
      role: 'system',
      content: prompt + langInstruction + buildToolInstructions(this.render),
    }
    log.debug('System prompt 已设置 (语音: %s, 显示: %s)', voiceLang || '默认', displayLang || '默认')
  }

  /** 重置对话 */
  reset() {
    const prevLen = this.messages.length
    this.messages = getDefaultMessages()
    if (this.customPrompt) {
      this.rebuildSystemPrompt()
    }
    log.info('对话已重置 (之前 %d 条消息)', prevLen)
  }

  /** 添加用户消息 */
  addUserMessage(content: string) {
    this.messages.push({ role: 'user', content })
    this.prune()
    log.debug('用户消息已添加, 当前 %d 条', this.messages.length)
  }

  /** 添加助手回复（纯文本） */
  addAssistantMessage(content: string) {
    this.messages.push({ role: 'assistant', content })
    log.debug('助手消息已添加, 回复长度: %d 字符', content.length)
  }

  /**
   * 添加带 tool_calls 的助手消息
   * 例如: {"role":"assistant","content":null,"tool_calls":[...]}
   */
  addAssistantToolCall(toolCalls: any[]) {
    this.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: toolCalls,
    })
    log.debug('助手工具调用已添加: %d 个', toolCalls.length)
  }

  /** 添加工具执行结果（自动截断过长内容） */
  addToolResult(toolCallId: string, content: string) {
    const truncated = content.length > MAX_TOOL_RESULT_LENGTH
      ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n\n...（截断，原 ${content.length} 字符）`
      : content
    this.messages.push({
      role: 'tool',
      content: truncated,
      tool_call_id: toolCallId,
    })
    log.debug('工具结果已添加: %s (长度: %d → %d)', toolCallId, content.length, truncated.length)
  }

  /**
   * 获取完整消息列表（供 API 调用）
   *
   * 会在末尾自动追加每轮的说话提醒（利用近因偏差），
   * 强化模型"用 say 工具说话"的记忆。不修改内部存储的消息列表。
   */
  getMessages(): ChatMessage[] {
    // 复制一份，注入每轮说话提醒
    const msgs = [...this.messages]
    if (this.voiceLang && this.displayLang) {
      msgs.push({
        role: 'system',
        content: buildTurnReminder(this.voiceLang, this.displayLang),
      })
    }
    return msgs
  }

  /** 获取消息数量 */
  get length(): number {
    return this.messages.length
  }

  /**
   * 裁剪超出 token 阈值的上下文
   *
   * 策略（按优先级）：
   * 1. 保留 system prompt（索引 0）
   * 2. 从最旧的非 system 消息开始移除
   * 3. 直到估计 token 数 ≤ maxContextTokens
   *
   * 快速路径：消息数量 ≤ 2×maxRounds 时跳过检查（小对话无需裁剪）。
   */
  private prune() {
    if (this.messages.length <= 1) return

    // 快速路径：消息数远低于阈值时不检查 token
    const rest = this.messages.slice(1)
    if (rest.length <= this.maxRounds * 2) return

    // Token 感知裁剪：移除最旧的非 system 消息直到 token 数低于阈值
    let tokens = this.estimatedTokens
    let removedCount = 0
    while (this.messages.length > 1 && tokens > this.maxContextTokens) {
      const removed = this.messages.splice(1, 1)[0]
      tokens -= estimateTokens(removed.content || '')
      removedCount++
    }

    if (this.messages.length <= 1) {
      log.warn('上下文裁剪至仅剩 system prompt，可能丢失了有用信息')
    } else if (removedCount > 0) {
      log.debug('上下文裁剪完成: 移除 %d 条, 剩余 %d 条, ~%d tokens',
        removedCount, this.messages.length, this.estimatedTokens)
    }
  }
}
