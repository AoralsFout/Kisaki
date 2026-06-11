/**
 * 工具执行器
 *
 * 解析 LLM 返回的 tool_calls, 执行对应工具, 返回结果。
 */
import { getTool } from './registry'
import type { ToolCall, ToolResult } from './types'
import { createLogger } from '../utils/logger'

const log = createLogger('AgentExec')

/** LLM 响应 choice 结构中的 tool_calls 字段 */
interface LLMChoice {
  delta?: { tool_calls?: Array<Record<string, unknown>> }
  message?: { tool_calls?: Array<Record<string, unknown>> }
}

/** 解析 LLM 响应中的 tool_calls */
export function parseToolCalls(choice: LLMChoice): ToolCall[] {
  const calls: ToolCall[] = []
  const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? []

  for (const tc of toolCalls) {
    try {
      const fn = tc.function as Record<string, unknown> | undefined
      calls.push({
        id: String(tc.id ?? ''),
        name: String(fn?.name ?? ''),
        arguments: JSON.parse(String(fn?.arguments ?? '{}')),
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
    log.warn('未知工具调用: %s', tc.name)
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: `错误: 未知工具 "${tc.name}"`,
    }
  }

  log.debug('执行工具: %s, 参数: %o', tc.name, tc.arguments)
  try {
    const result = await tool.handler(tc.arguments)
    log.info('工具执行完成: %s', tc.name)
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: result,
    }
  } catch (err) {
    log.warn('工具执行失败: %s - %s', tc.name, (err as Error).message)
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
