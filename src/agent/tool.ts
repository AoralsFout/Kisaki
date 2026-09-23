/** Agent 具体工具实现类型；模型协议契约归属 domain/tools。 */

import type { ToolOutput, ToolDefinition } from '../domain/tools/contracts'
import type { ToolExecutionContext } from '../domain/tools/ports'

/** 单个工具实现。 */
export interface Tool<TOutput extends string | ToolOutput = string> {
  /** 工具定义（发给 LLM）。 */
  definition: ToolDefinition
  /** 执行函数。 */
  handler: (args: Record<string, any>, context?: ToolExecutionContext) => Promise<TOutput>
  /** 适用的渲染类型；缺省为两者皆可。 */
  appliesTo?: 'illustration' | 'live2d' | 'both'
  /** 执行要求，由工具策略与注册表消费。 */
  policy?: ToolPolicyDescriptor
}

export interface ToolPolicyDescriptor {
  requiresWorkspace?: boolean
  approval?: 'file-session' | 'command' | 'screen-capture'
  checkpointArgument?: string
}
