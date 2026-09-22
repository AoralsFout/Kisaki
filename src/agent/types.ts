/** Agent 具体工具实现类型。共享协议契约位于 domain/tools。 */

import type {
  ToolDefinition,
  ToolOutput,
} from '../domain/tools/contracts'

export type {
  ToolCall,
  ToolDefinition,
  ToolImage,
  ToolOutput,
  ToolParameter,
  ToolResult,
} from '../domain/tools/contracts'

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
  /** 执行要求，由 ToolExecutionCoordinator 与 registry 消费。 */
  policy?: ToolPolicyDescriptor
}

export interface ToolPolicyDescriptor {
  requiresWorkspace?: boolean
  approval?: 'file-session' | 'command' | 'screen-capture'
  checkpointArgument?: string
}
