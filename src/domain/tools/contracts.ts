/**
 * 工具协议契约。
 *
 * 这里仅放模型、回合编排和工具适配器共同理解的数据形状；不得依赖
 * Agent 实现、应用编排、Vue/Pinia 或 Tauri。具体工具的 handler 与注册
 * 仍归 Agent 模块所有。
 */

/** 工具参数定义（JSON Schema 的稳定子集）。 */
export interface ToolParameter {
  type: string
  description?: string
  properties?: Record<string, ToolParameter>
  required?: string[]
  items?: ToolParameter
  enum?: string[]
}

/** 发给模型的工具定义。 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

/** 工具交给多模态模型观察的图片。 */
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

/** 模型返回的工具调用。 */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
  requestId?: string
  turn?: number
}

/** 工具执行结果。 */
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

/** 角色工具运行时的外观快照。 */
export interface ToolCharacterLook {
  emotion: string
  stance: string
  costume: string
  screenPose: string
}

/** 工具清单装配所需的、与具体角色实现无关的角色数据投影。 */
export interface ToolCharacterData {
  id?: string
  name?: string
  voice?: string
  voiceLanguage?: string
  textLanguage?: string
  render?: 'illustration' | 'live2d'
  emotions?: readonly string[]
  poses?: readonly string[]
  costumes?: readonly string[]
}

/** 工具清单装配所需的角色运行时能力投影。 */
export interface ToolCharacterCapabilities {
  emotions: readonly string[]
  stances?: readonly string[]
  costumes?: readonly string[]
  screenPoses?: readonly string[]
  motions: readonly {
    group: string
    count?: number
    description?: string
  }[]
  emotionDescriptions: Readonly<Record<string, string>>
}

/** 一次模型请求可见工具的筛选上下文。 */
export interface ToolCatalogContext {
  data: ToolCharacterData | null
  capabilities: ToolCharacterCapabilities | null
  /** 当前工作目录能力；清单只在使用点按是否为空派生可见性。 */
  workspaceGrantId: string | null
}
