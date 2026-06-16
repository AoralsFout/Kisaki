/**
 * say —— 角色"说话"工具定义
 *
 * 角色与用户对话的唯一方式：把台词放进 say 的参数，而非写在普通正文里。
 * 这样"说话"成为一次函数调用，可与动作工具（情绪/姿势等）在同一条回复里并存，
 * 也不再依赖脆弱的双语文本格式或 response_format。
 *
 * 注意：say 是对话层（chat store）的职责——它的"执行"就是渲染气泡 + 触发 TTS，
 * 因此**不注册进 agent registry/executor**，仅由 chat store 拼进发给 LLM 的工具列表。
 */
import type { ToolDefinition } from '../types'

/** say 工具名（供 chat store 识别终止性调用） */
export const SAY_TOOL_NAME = 'say'

/** say 工具定义（发送给 LLM） */
export const SAY_TOOL_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: SAY_TOOL_NAME,
    description:
      '说出你的台词。这是你与用户对话的唯一方式——每次开口说话都必须调用它。' +
      '即使你同时切换了表情/姿势/服装，最后也要调用 say 把话说出来。',
    parameters: {
      type: 'object',
      properties: {
        voice: {
          type: 'string',
          description:
            '你用母语说出的台词，将被合成为语音。必须是纯口语化的自然语言：' +
            '不含 emoji、颜文字、特殊符号，也不含对动作或心理的描写（例如不要写"（微笑）"）。',
        },
        display: {
          type: 'string',
          description:
            '把上面的台词翻译成用户显示语言的版本，用于在屏幕上显示。' +
            '如果你的母语与用户显示语言相同，可以省略此项。',
        },
      },
      required: ['voice'],
    },
  },
}
