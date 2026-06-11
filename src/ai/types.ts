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

/** Response format 选项（用于支持结构化输出的 provider） */
export interface ResponseFormat {
  type: 'json_schema' | 'json_object'
  json_schema?: {
    name: string
    strict?: boolean
    schema: Record<string, unknown>
  }
}

/**
 * OpenAI 兼容的双语输出 JSON Schema
 *
 * 适用于 gpt-4o-mini、gpt-4o、o1、o3 等支持结构化输出的模型。
 * 强制模型输出 {"native_text": "...", "display_text": "..."} 格式。
 */
export const BILINGUAL_OUTPUT_SCHEMA: ResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'bilingual_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        native_text: {
          type: 'string',
          description: '角色的母语内容，用于语音合成（TTS）',
        },
        display_text: {
          type: 'string',
          description: '翻译为用户显示语言的版本',
        },
      },
      required: ['native_text', 'display_text'],
      additionalProperties: false,
    },
  },
}

/**
 * DeepSeek 兼容的双语输出 JSON 模式
 *
 * DeepSeek 不支持 strict json_schema，但支持 response_format: { type: "json_object" }。
 * 该模式强制输出有效 JSON，但由系统提示词指导具体字段结构。
 */
export const BILINGUAL_JSON_MODE: ResponseFormat = {
  type: 'json_object',
}
