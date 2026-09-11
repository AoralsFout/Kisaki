import type { ToolCall, ToolResult } from '../../agent/types'

export interface ProtocolToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolCallParseError {
  code: 'INVALID_TOOL_ARGUMENTS'
  message: string
}

export interface NormalizedToolInvocation {
  protocolCall: ProtocolToolCall
  call: ToolCall | null
  parseError: ToolCallParseError | null
}

export interface ToolCallBatch {
  source: 'native' | 'text'
  assistantText?: string
  sayCall: ProtocolToolCall | null
  actions: NormalizedToolInvocation[]
  /** 必须随 assistant 协议消息一并提交的调用。 */
  protocolCalls: ProtocolToolCall[]
}

interface ToolCallIdentity {
  requestId: string
  turn: number
  sayToolName: string
}

function invocation(protocolCall: ProtocolToolCall, identity: ToolCallIdentity): NormalizedToolInvocation {
  try {
    const args: unknown = JSON.parse(protocolCall.function.arguments || '{}')
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('工具参数必须是 JSON 对象')
    }
    return {
      protocolCall,
      call: {
        id: protocolCall.id,
        name: protocolCall.function.name,
        arguments: args as Record<string, unknown>,
        requestId: identity.requestId,
        turn: identity.turn,
      },
      parseError: null,
    }
  } catch (error) {
    return {
      protocolCall,
      call: null,
      parseError: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** 归一化服务端原生 function call，仅保留第一个 say 调用。 */
export function normalizeNativeToolCalls(
  calls: readonly ProtocolToolCall[],
  identity: ToolCallIdentity,
  assistantText?: string,
): ToolCallBatch {
  let sayCall: ProtocolToolCall | null = null
  const actions: NormalizedToolInvocation[] = []
  for (const call of calls) {
    if (call.function.name === identity.sayToolName) {
      if (!sayCall) sayCall = call
      continue
    }
    actions.push(invocation(call, identity))
  }
  return {
    source: 'native',
    assistantText,
    sayCall,
    actions,
    protocolCalls: [...actions.map(action => action.protocolCall), ...(sayCall ? [sayCall] : [])],
  }
}

/** 把已解析的文本兜底调用归一化进同一个协议批次。 */
export function normalizeTextToolCalls(
  calls: readonly ToolCall[],
  identity: ToolCallIdentity,
  assistantText?: string,
): ToolCallBatch {
  const protocolCalls: ProtocolToolCall[] = calls.map(call => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }))
  return {
    ...normalizeNativeToolCalls(protocolCalls, identity, assistantText),
    source: 'text',
  }
}

export interface ToolCallOutcome {
  invocation: NormalizedToolInvocation
  result: ToolResult
}

export interface ToolCallBatchResult {
  outcomes: ToolCallOutcome[]
  failureCount: number
  needsFollowup: boolean
}

export interface ToolCallBatchHooks {
  onStart?: (invocation: NormalizedToolInvocation, index: number, count: number) => unknown | Promise<unknown>
  onResult?: (outcome: ToolCallOutcome, index: number, count: number) => unknown | Promise<unknown>
}

function invalidArgumentsResult(invocation: NormalizedToolInvocation): ToolResult {
  return {
    role: 'tool',
    tool_call_id: invocation.protocolCall.id,
    content: '参数解析失败',
    ok: false,
    code: 'INVALID_TOOL_ARGUMENTS',
    retryable: false,
  }
}

/** 让归一化后的动作批次串行经过同一条工具流水线执行。 */
export async function executeToolCallBatch(
  actions: readonly NormalizedToolInvocation[],
  execute: (call: ToolCall) => Promise<ToolResult>,
  hooks: ToolCallBatchHooks = {},
): Promise<ToolCallBatchResult> {
  const outcomes: ToolCallOutcome[] = []
  let failureCount = 0
  let needsFollowup = false

  for (let index = 0; index < actions.length; index++) {
    const current = actions[index]
    await hooks.onStart?.(current, index, actions.length)
    const result = current.call ? await execute(current.call) : invalidArgumentsResult(current)
    const outcome = { invocation: current, result }
    outcomes.push(outcome)
    if (result.ok === false && result.code !== 'USER_REJECTED') failureCount++
    if (result.ok === false || result.code === 'USER_REJECTED') needsFollowup = true
    await hooks.onResult?.(outcome, index, actions.length)
  }

  return { outcomes, failureCount, needsFollowup }
}
