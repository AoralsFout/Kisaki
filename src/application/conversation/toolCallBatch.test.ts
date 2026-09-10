import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '../../agent/types'
import {
  executeToolCallBatch,
  normalizeNativeToolCalls,
  normalizeTextToolCalls,
  type ProtocolToolCall,
} from './toolCallBatch'

const nativeCall = (id: string, name: string, args: string): ProtocolToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
})

const identity = { requestId: 'request-1', turn: 2, sayToolName: 'say' }

describe('tool call normalization', () => {
  it('normalizes native calls and retains only the first say in protocol context', () => {
    const batch = normalizeNativeToolCalls([
      nativeCall('a', 'read_file', '{"path":"a.txt"}'),
      nativeCall('s1', 'say', '{"display":"done"}'),
      nativeCall('s2', 'say', '{"display":"duplicate"}'),
    ], identity)

    expect(batch.sayCall?.id).toBe('s1')
    expect(batch.actions[0].call).toEqual({
      id: 'a',
      name: 'read_file',
      arguments: { path: 'a.txt' },
      requestId: 'request-1',
      turn: 2,
    })
    expect(batch.protocolCalls.map(call => call.id)).toEqual(['a', 's1'])
  })

  it('normalizes text fallback calls through the same representation', () => {
    const calls: ToolCall[] = [{ id: 'a', name: 'read_file', arguments: { path: 'a.txt' } }]
    const batch = normalizeTextToolCalls(calls, identity, 'remaining text')

    expect(batch.source).toBe('text')
    expect(batch.assistantText).toBe('remaining text')
    expect(batch.actions[0].protocolCall.function.arguments).toBe('{"path":"a.txt"}')
    expect(batch.actions[0].call?.requestId).toBe('request-1')
  })

  it('turns malformed native arguments into a structured parse failure', () => {
    const batch = normalizeNativeToolCalls([nativeCall('bad', 'read_file', '{')], identity)
    expect(batch.actions[0].call).toBeNull()
    expect(batch.actions[0].parseError?.code).toBe('INVALID_TOOL_ARGUMENTS')
  })
})

describe('executeToolCallBatch', () => {
  it('executes sequentially and reports failures through one result model', async () => {
    const batch = normalizeNativeToolCalls([
      nativeCall('good', 'read_file', '{}'),
      nativeCall('bad', 'write_file', '{'),
    ], identity)
    const execute = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      role: 'tool',
      tool_call_id: call.id,
      content: 'ok',
      ok: true,
    }))
    const completed: string[] = []

    const result = await executeToolCallBatch(batch.actions, execute, {
      onResult: outcome => completed.push(outcome.result.tool_call_id),
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(completed).toEqual(['good', 'bad'])
    expect(result.failureCount).toBe(1)
    expect(result.needsFollowup).toBe(true)
    expect(result.outcomes[1].result).toMatchObject({
      ok: false,
      code: 'INVALID_TOOL_ARGUMENTS',
      retryable: false,
    })
  })

  it('requests a follow-up without counting user rejection as execution failure', async () => {
    const batch = normalizeNativeToolCalls([nativeCall('write', 'write_file', '{}')], identity)
    const result = await executeToolCallBatch(batch.actions, async call => ({
      role: 'tool',
      tool_call_id: call.id,
      content: '用户已拒绝文件操作，未执行。',
      ok: false,
      code: 'USER_REJECTED',
      retryable: false,
    }))

    expect(result).toMatchObject({ failureCount: 0, needsFollowup: true })
  })
})
