/**
 * 对话上下文管理
 *
 * 维护多轮对话历史，自动裁剪超出长度的消息。
 * 支持 tool calls / tool results 消息（用于 Function Calling）。
 */
import type { ChatMessage } from './types'
import { getDefaultMessages } from './prompts'
import { createLogger } from '../utils/logger'

const log = createLogger('ChatContext')

/** 最大保留的对话轮数（一轮 = 一问一答） */
const MAX_ROUNDS = 10

/** 最大上下文 token 数（留出回复空间，默认模型上下文窗口通常 8k–128k） */
const MAX_CONTEXT_TOKENS = 6000

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

/** 语言代码 → 中文名称映射 */
const LANG_NAMES: Record<string, string> = {
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

function langName(code: string): string {
  return LANG_NAMES[code] || code
}

/**
 * 构建双语回复格式指令
 * @param voiceLang 角色语音语言（TTS 合成用），如 "ja-JP"
 * @param displayLang 用户显示语言，如 "zh-CN"
 */
function buildLangInstruction(voiceLang: string, displayLang: string): string {
  const voiceLangName = langName(voiceLang)
  const displayLangName = langName(displayLang)

  // 如果语音语言和显示语言相同，不需要双语格式
  if (voiceLang === displayLang) {
    return `\n\n## 📝 语言要求\n你的母语是 ${voiceLangName}。请用 ${voiceLangName} 回复。`
  }

  return `\n\n## 📝 双语回复格式（必须遵守）

你的母语是 ${voiceLangName}，但用户使用 ${displayLangName}。

每次回复你必须同时输出以下两个部分：
1. 【${voiceLangName}】用你的母语（${voiceLangName}）自然说出的话（用于语音合成）
2. 【译文】翻译成用户语言（${displayLangName}）的版本（用于显示）

格式：
【${voiceLangName}】<角色母语内容>
【译文】<用户语言内容>

示例（母语=日语，用户语言=中文）：
【日本語】こんにちは、お兄さん。今日はどうしたの？
【译文】你好呀，哥哥。今天怎么啦？

注意：
- 即使调用了工具，最终回复也要遵循此格式
- 母语内容必须是由母语文字和标点符号组合，可以被合成为语音的文本。不允许出现emoji，特殊符号，颜文字等不可语音合成内容。也不允许出现对想法或动作的描述。
- 不要省略任一字段`
}

/** 为每轮生成的简短格式提醒（利用近因偏差） */
function buildTurnReminder(voiceLang: string, displayLang: string): string {
  return `[格式提醒] 请务必使用双语格式回复 — 先写【${langName(voiceLang)}】<语音内容> 再写【译文】<展示内容>，两部分都不能省略。`
}

/**
 * 为支持结构化输出的 provider 构建 JSON 格式指令
 * 替换 system prompt 中的语言要求部分（不在 getMessages 注入，而是直接修改 system prompt）
 */
function buildJsonLangInstruction(voiceLang: string, displayLang: string): string {
  const voiceLangName = langName(voiceLang)
  const displayLangName = langName(displayLang)

  if (voiceLang === displayLang) {
    return `\n\n## 📝 语言要求\n你的母语是 ${voiceLangName}。请用 ${voiceLangName} 回复。`
  }

  return `\n\n## 📝 双语回复格式（JSON 结构化输出）

你的母语是 ${voiceLangName}，但用户使用 ${displayLangName}。

每次回复你**必须**输出一个 JSON 对象，包含两个字段：
1. "native_text": 用你的母语（${voiceLangName}）自然说出的话（用于语音合成）。必须是纯母语文字，不允许添加额外想法或动作，不允许有 emoji 或特殊符号。
2. "display_text": 翻译成用户语言（${displayLangName}）的版本（用于显示）

示例（母语=日语，用户语言=中文）：
{"native_text": "こんにちは、お兄さん。今日はどうしたの？", "display_text": "你好呀，哥哥。今天怎么啦？"}

即使调用了工具，最终回复也要遵循此格式。`
}

/** 工具使用说明（自动追加到所有角色提示词末尾） */
const TOOL_INSTRUCTIONS = `
## 🔧 函数调用规则（必须遵守）
你的文字回复不会改变你的任何状态。只有通过函数调用才能实际改变你的姿势、表情、服装和屏幕位置。

### 你必须使用函数调用的场景
1. 用户要求你改变外观时 → 必须调用 set_character_* 相关函数
2. 用户询问时间/天气/计算结果时 → 必须调用 get_time / get_weather / calculator
3. 你的情绪发生变化时 → 调用 set_character_emotion
4. 你希望改变姿势或服装时 → 调用 set_character_stance / set_character_costume
5. 你需要改变你在屏幕的大小或位置时 → 调用 set_screen_pose

### 错误示例 ❌
用户: "换个姿势"
你回复: "好的，我站起来"（然后什么都没发生 ❌）

### 正确示例 ✅
用户: "换个姿势"
你调用 set_character_stance() → 实际生效 ✅
然后回复: "好了~"

### 可用函数列表
- set_character_emotion(emotion): 切换表情
- set_character_stance(stance): 切换身体姿势
- set_character_costume(costume): 切换服装
- set_character_look(stance?, emotion?, costume?): 一步设置多项
- set_screen_pose(pose): 控制屏幕位置和大小
- get_character_state(): 查询你当前的状态
- get_time(timezone?): 获取当前时间
- get_weather(city, days?): 查询天气
- calculator(expression): 数学计算
- switch_character(character_id): 切换到其他角色`

/** 对话上下文管理器 */
export class ChatContext {
  private messages: ChatMessage[] = []
  private maxRounds: number
  private customPrompt: string | null = null
  private voiceLang: string = ''
  private displayLang: string = ''
  private structured: boolean = false
  private maxContextTokens: number

  constructor(maxRounds: number = MAX_ROUNDS, maxContextTokens: number = MAX_CONTEXT_TOKENS) {
    this.maxRounds = maxRounds
    this.maxContextTokens = maxContextTokens
    this.reset()
  }

  /** 启用/禁用结构化输出模式（JSON Schema），改动将在下次 setSystemPrompt 时生效 */
  setStructuredOutput(enabled: boolean) {
    if (this.structured === enabled) return
    this.structured = enabled
    // 立即重建 system prompt 使其生效
    if (this.customPrompt && this.voiceLang && this.displayLang) {
      this.rebuildSystemPrompt()
    }
    log.debug('结构化输出 %s', enabled ? '启用' : '禁用')
  }

  /** 是否已启用结构化输出 */
  get isStructured(): boolean {
    return this.structured
  }

  /** 格式违规标记：下次 getMessages 调用时附加完整格式指令（而非简短提醒） */
  private needsFullFormatReattach: boolean = false

  /** 标记格式违规：下次 API 请求将重新附上完整的双语格式指令 */
  markFormatViolation() {
    this.needsFullFormatReattach = true
    log.debug('格式违规已标记，下次 getMessages 将附加完整格式指令')
  }

  /** 重置格式违规标记 */
  private resetFormatViolationMarker() {
    this.needsFullFormatReattach = false
  }

  /** 当前上下文估计 token 总数（用于裁剪决策） */
  get estimatedTokens(): number {
    return this.messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0)
  }

  /** 重建 system prompt（应用语言指令变更） */
  private rebuildSystemPrompt() {
    if (!this.customPrompt || !this.voiceLang || !this.displayLang) return
    const langFn = this.structured ? buildJsonLangInstruction : buildLangInstruction
    this.messages[0] = {
      role: 'system',
      content: this.customPrompt + langFn(this.voiceLang, this.displayLang) + TOOL_INSTRUCTIONS,
    }
    log.debug('System prompt 已重建 (结构化=%s, 语音: %s, 显示: %s)',
      this.structured, this.voiceLang, this.displayLang)
  }

  /** 设置自定义 system prompt（自动追加语言指令和工具说明） */
  setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string) {
    this.customPrompt = prompt
    this.voiceLang = voiceLang || ''
    this.displayLang = displayLang || ''
    const langFn = this.structured ? buildJsonLangInstruction : buildLangInstruction
    const langInstruction = voiceLang && displayLang ? langFn(voiceLang, displayLang) : ''
    this.messages[0] = {
      role: 'system',
      content: prompt + langInstruction + TOOL_INSTRUCTIONS,
    }
    log.debug('System prompt 已设置 (结构化=%s, 语音: %s, 显示: %s)',
      this.structured, voiceLang || '默认', displayLang || '默认')
  }

  /** 重置对话 */
  reset() {
    const prevLen = this.messages.length
    this.messages = getDefaultMessages()
    this.resetFormatViolationMarker()
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
   * 会在末尾自动追加每轮的格式提醒（利用近因偏差），
   * 若之前发生过格式违规，则自动附加完整格式指令（而非简短提醒），
   * 以强化模型对双语言格式的记忆。
   * 不修改内部存储的消息列表。
   */
  getMessages(): ChatMessage[] {
    // 复制一份，注入每轮格式提醒
    const msgs = [...this.messages]
    if (this.voiceLang && this.displayLang) {
      if (this.needsFullFormatReattach) {
        // 格式违规后重新附上完整格式指令，附带示例和注意事项
        const langFn = this.structured ? buildJsonLangInstruction : buildLangInstruction
        msgs.push({
          role: 'system',
          content: langFn(this.voiceLang, this.displayLang),
        })
        log.debug('格式违规恢复：已附加完整格式指令 (voice=%s display=%s structured=%s)',
          this.voiceLang, this.displayLang, this.structured)
        this.needsFullFormatReattach = false
      } else {
        msgs.push({
          role: 'system',
          content: buildTurnReminder(this.voiceLang, this.displayLang),
        })
      }
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
