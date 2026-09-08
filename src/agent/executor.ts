/**
 * 工具执行器
 *
 * 解析 LLM 返回的 tool_calls, 执行对应工具, 返回结果。
 */
import { getTool } from './registry'
import type { ToolCall, ToolResult } from './types'
import { createLogger } from '../utils/logger'

const log = createLogger('AgentExec')

/**
 * Tauri 的 invoke 失败通常直接 reject 字符串，而不是 Error 实例。
 * 统一格式化所有未知异常，避免日志和工具回执退化成 `undefined`。
 */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error != null) {
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch { /* ignore */ }
    const text = String(error)
    if (text && text !== '[object Object]') return text
  }
  return '未知错误'
}

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
    log.warn("agent_exec.execute_tool_call.warn", `未知工具调用: ${tc.name}`, undefined, { tc_name: tc.name })
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: `错误: 未知工具 "${tc.name}"`,
    }
  }

  log.debug("agent_exec.execute_tool_call.debug", `执行工具: ${tc.name}, 参数: ${JSON.stringify(tc.arguments)}`, { tc_name: tc.name, tc_arguments: tc.arguments })
  try {
    const output = await tool.handler(tc.arguments)
    const result = typeof output === 'string' ? { content: output } : output
    log.info("agent_exec.execute_tool_call.info", `工具执行完成: ${tc.name}`, { tc_name: tc.name })
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: result.content,
      images: result.images,
    }
  } catch (err) {
    const message = toolErrorMessage(err)
    log.error("agent.tool_failed", "工具执行失败", err, {
      toolName: tc.name,
      toolCallId: tc.id,
      message,
    })
    return {
      role: 'tool',
      tool_call_id: tc.id,
      content: `工具执行错误: ${message}`,
    }
  }
}

/** 执行所有工具调用（可并行执行无依赖的工具） */
export async function executeToolCalls(tcList: ToolCall[]): Promise<ToolResult[]> {
  return Promise.all(tcList.map(tc => executeToolCall(tc)))
}
