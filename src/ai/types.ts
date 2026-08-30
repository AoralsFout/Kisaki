/** AI 配置 */
export interface AIConfig {
  /** API 地址（兼容 OpenAI 格式） */
  baseURL: string
  /** API Key */
  apiKey: string
  /** 模型名称 */
  model: string
  /**
   * Key 存储方式标记：'keychain' = 明文保存在系统密钥链，apiKey 字段为空；
   * 缺省 = 本地加密存储（旧方案 / 密钥链不可用时的回退）。
   */
  keyStorage?: 'keychain'
}

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 可随用户消息发送给图像识别模型的本地图片。 */
export interface ImageAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  size: number
}

export interface ChatInputPayload {
  text: string
  images: ImageAttachment[]
}

/** OpenAI 兼容的多模态消息内容。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export type ChatMessageContent = string | ChatContentPart[]

/** 对话消息 */
export interface ChatMessage {
  role: MessageRole
  content: ChatMessageContent
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
  /** 检测到工具调用（流式累积完成后触发）。text 为同条回复里一并产出的正文（可能为空），供兜底使用 */
  onTools?: (tools: ToolCallData[], text?: string) => void
  /** 流式结束 */
  onDone: (fullText: string) => void
  /** 出错 */
  onError: (error: Error) => void
}

/** Response format 选项（用于支持结构化输出的 provider） */
export interface ResponseFormat {
  type: 'json_schema' | 'json_object'
  json_schema?: {
    name: string
    strict?: boolean
    schema: Record<string, unknown>
  }
}
