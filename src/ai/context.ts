/**
 * 对话上下文管理
 *
 * 维护多轮对话历史，自动裁剪超出长度的消息。
 * 支持 tool calls / tool results 消息（用于 Function Calling）。
 */
import type { ChatMessage } from './types'
import { getDefaultMessages } from './prompts'

/** 最大保留的对话轮数（一轮 = 一问一答） */
const MAX_ROUNDS = 10

/**
 * 构建双语回复格式指令
 * @param voiceLang 角色语音语言（TTS 合成用），如 "ja-JP"
 * @param displayLang 用户显示语言，如 "zh-CN"
 */
function buildLangInstruction(voiceLang: string, displayLang: string): string {
  const langNames: Record<string, string> = {
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
  const voiceLangName = langNames[voiceLang] || voiceLang
  const displayLangName = langNames[displayLang] || displayLang

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
- 母语内容必须是由母语文字和标点符号组合，可以被合成为语音的文本。不允许出现emoji，特殊符号，颜文字等不可语音合成内容
- 不要省略任一字段`
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

  constructor(maxRounds: number = MAX_ROUNDS) {
    this.maxRounds = maxRounds
    this.reset()
  }

  /** 设置自定义 system prompt（自动追加语言指令和工具说明） */
  setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string) {
    this.customPrompt = prompt
    const langInstruction = voiceLang && displayLang ? buildLangInstruction(voiceLang, displayLang) : ''
    this.messages[0] = {
      role: 'system',
      content: prompt + langInstruction + TOOL_INSTRUCTIONS,
    }
  }

  /** 重置对话 */
  reset() {
    this.messages = getDefaultMessages()
    if (this.customPrompt) {
      this.messages[0] = { role: 'system', content: this.customPrompt }
    }
  }

  /** 添加用户消息 */
  addUserMessage(content: string) {
    this.messages.push({ role: 'user', content })
    this.prune()
  }

  /** 添加助手回复（纯文本） */
  addAssistantMessage(content: string) {
    this.messages.push({ role: 'assistant', content })
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
  }

  /** 添加工具执行结果 */
  addToolResult(toolCallId: string, content: string) {
    this.messages.push({
      role: 'tool',
      content,
      tool_call_id: toolCallId,
    })
  }

  /** 获取完整消息列表（供 API 调用） */
  getMessages(): ChatMessage[] {
    return this.messages
  }

  /** 获取消息数量 */
  get length(): number {
    return this.messages.length
  }

  /**
   * 裁剪超出轮数的对话
   * 保留 system prompt 和最近的 N 轮
   * tool_call + tool_result 算一轮
   */
  private prune() {
    const systemMsg = this.messages[0]
    const rest = this.messages.slice(1)
    const total = rest.length

    if (total > this.maxRounds * 4) {
      // 按比例裁剪，保留尾部最近的 N*4 条
      const keep = this.maxRounds * 4
      this.messages = [systemMsg, ...rest.slice(total - keep)]
    }
  }
}
