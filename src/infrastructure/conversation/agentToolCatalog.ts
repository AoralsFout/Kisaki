/**
 * 工具清单端口的适配器，建在既有的 agent 外观之上。
 *
 * 端口把「本次请求能用哪些工具」定为纯数据（定义、文本兜底提取、剥离），
 * 与执行流水线分开；这里只做转发，不改变任何既有语义。
 */
import { agentService } from '../../agent/service'
import type { CharacterToolContext } from '../../agent/registry'
import type { ToolCall, ToolDefinition } from '../../agent/types'
import type { ConversationToolCatalog } from '../../application/conversation/conversationSession'

export class AgentServiceToolCatalog implements ConversationToolCatalog {
  /** 本次请求的工具定义（含角色枚举值注入）；没有角色时由角色数据收敛。 */
  definitions(context: CharacterToolContext): ToolDefinition[] {
    return agentService.getToolDefinitions(context)
  }

  extractTextToolCalls(text: string): ToolCall[] {
    return agentService.extractTextToolCalls(text)
  }

  stripTextToolCalls(text: string): string {
    return agentService.stripTextToolCalls(text)
  }
}
