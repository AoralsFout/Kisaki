/**
 * Agent 能力 - 类型定义
 */

/** 工具参数定义（JSON Schema） */
export interface ToolParameter {
  type: string
  description?: string
  properties?: Record<string, ToolParameter>
  required?: string[]
  items?: ToolParameter
  enum?: string[]
}

/** 工具定义（发送给 LLM） */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

/** 单个工具实现 */
export interface Tool<TOutput extends string | ToolOutput = string> {
  /** 工具定义（发给 LLM） */
  definition: ToolDefinition
  /** 执行函数 */
  handler: (args: Record<string, any>) => Promise<TOutput>
  /**
   * 适用的渲染类型：'illustration' 仅静态立绘角色、'live2d' 仅 Live2D 角色、
   * 'both'（默认）两者皆可。registry.getDefinitions 按当前角色 render 过滤。
   */
  appliesTo?: 'illustration' | 'live2d' | 'both'
}

/** 工具交给多模态模型观察的图片（不会作为普通文本/base64 写入工具回执）。 */
export interface ToolImage {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  size: number
}

/** 除文本回执外可携带图片的工具输出。 */
export interface ToolOutput {
  content: string
  images?: ToolImage[]
}

/** LLM 返回的工具调用 */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
  requestId?: string
  turn?: number
}

/** 工具执行结果 */
export interface ToolResult {
  role: 'tool'
  tool_call_id: string
  content: string
  /** 结构化执行状态；旧调用方可省略，消费者再回退到文本判断。 */
  ok?: boolean
  /** 稳定错误码，供流程控制和遥测使用，避免解析本地化错误文本。 */
  code?: string
  /** 当前条件变化后是否值得重试。 */
  retryable?: boolean
  /** 由上层在全部 tool 回执写完后，以多模态消息交给模型观察。 */
  images?: ToolImage[]
}
