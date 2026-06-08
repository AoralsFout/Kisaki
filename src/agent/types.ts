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
export interface Tool {
  /** 工具定义（发给 LLM） */
  definition: ToolDefinition
  /** 执行函数 */
  handler: (args: Record<string, any>) => Promise<string>
}

/** LLM 返回的工具调用 */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

/** 工具执行结果 */
export interface ToolResult {
  role: 'tool'
  tool_call_id: string
  content: string
}
