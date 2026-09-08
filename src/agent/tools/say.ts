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
      '最终提交你要对用户说的台词，并立即终止当前工具循环。' +
      '只有在所有查询、操作和验证都已完成后才能单独调用一次。' +
      '不要用它播报中间进度，不要与其他工具同批调用，也不要在调用后安排任何操作。' +
      '如果缺少用户信息而无法继续，可以用它提交本轮最终问题。',
    parameters: {
      type: 'object',
      properties: {
        voice: {
          type: 'string',
          description:
            '你用母语说出的台词，将被直接送入语音合成。允许可朗读文字、阿拉伯数字、语言正常所需的空格、半角逗号，' +
            '以及数字常用的小数点、百分号、时间冒号、斜杠和正负号。阿拉伯数字、百分比、日期、时间、版本号、金额和运算式' +
            '可以保留数字原样，不要为了朗读改写成文字。禁止罗马数字、其他标点、换行、Markdown、emoji、颜文字或特殊符号；' +
            '网址、路径、代码和缩写仍应改写成适合口头表达的说法。不得包含动作或心理描写。',
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
