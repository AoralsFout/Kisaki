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

  /** 设置自定义 system prompt（自动追加工具说明） */
  setSystemPrompt(prompt: string) {
    this.customPrompt = prompt
    this.messages[0] = {
      role: 'system',
      content: prompt + TOOL_INSTRUCTIONS,
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
