/** AI 配置 */
export interface AIConfig {
  /** API 地址（兼容 OpenAI 格式） */
  baseURL: string
  /** API Key */
  apiKey: string
  /** 模型名称 */
  model: string
}

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 对话消息 */
export interface ChatMessage {
  role: MessageRole
  content: string
  /** tool_call 的 id（用于 tool 角色的回执） */
  tool_call_id?: string
  /** 工具调用列表（assistant 角色） */
  tool_calls?: ToolCallData[]
}

/** LLM 返回的工具调用 */
export interface ToolCallData {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** 工具定义参数 */
export interface ToolParamSchema {
  type: string
  description?: string
  properties?: Record<string, ToolParamSchema>
  required?: string[]
  items?: ToolParamSchema
  enum?: string[]
}

/** 流式回调 */
export interface StreamCallbacks {
  /** 收到普通内容增量 */
  onChunk: (chunk: string) => void
  /** 收到思考内容增量（如 DeepSeek 的 reasoning_content） */
  onThinking?: (chunk: string) => void
  /** 检测到工具调用（流式累积完成后触发） */
  onTools?: (tools: ToolCallData[]) => void
  /** 流式结束 */
  onDone: (fullText: string) => void
  /** 出错 */
  onError: (error: Error) => void
}
