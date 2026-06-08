/**
 * 工具执行器
 *
 * 解析 LLM 返回的 tool_calls, 执行对应工具, 返回结果。
 */
import { getTool } from './registry'
import type { ToolCall, ToolResult } from './types'

/** 解析 LLM 响应中的 tool_calls */
export function parseToolCalls(choice: any): ToolCall[] {
  const calls: ToolCall[] = []
  const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? []

  for (const tc of toolCalls) {
    try {
      calls.push({
        id: tc.id,
        name: tc.function?.name ?? '',
        arguments: JSON.parse(tc.function?.arguments ?? '{}'),
      })
    } catch {
      // 跳过解析失败的 tool_call
    }
  }
  return calls
}

/** 执行单个工具调用 */
export async function executeToolCall(tc: ToolCall): Promise<ToolResult> {
  const tool = getTool(tc.name)
  if (!tool) {
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: `错误: 未知工具 "${tc.name}"`,
    }
  }

  try {
    const result = await tool.handler(tc.arguments)
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: result,
    }
  } catch (err) {
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: `工具执行错误: ${(err as Error).message}`,
    }
  }
}

/** 执行所有工具调用（可并行执行无依赖的工具） */
export async function executeToolCalls(tcList: ToolCall[]): Promise<ToolResult[]> {
  return Promise.all(tcList.map(tc => executeToolCall(tc)))
}
