import type { ToolCall } from '../../agent/types'
import type { ModelStreamSnapshot } from './modelStreamDecoder'
import {
  normalizeNativeToolCalls,
  normalizeTextToolCalls,
  type ProtocolToolCall,
  type ToolCallBatch,
} from './toolCallBatch'

export type RawModelTurn =
  | { type: 'done'; text: string }
  | { type: 'tools'; calls: ProtocolToolCall[]; text?: string }

export type InterpretedModelTurn =
  | { type: 'final-text'; text: string }
  | { type: 'tool-batch'; batch: ToolCallBatch }
  | { type: 'empty' }

export interface ModelTurnInterpreterOptions {
  requestId: string
  turn: number
  sayToolName: string
  extractTextToolCalls: (text: string) => ToolCall[]
  stripTextToolCalls: (text: string) => string
}

/**
 * 把各家服务端特有的补全结构转换为对话层面的结果。
 * 原生 function call 与文本兜底调用经过这道边界后形态完全一致。
 */
export function interpretModelTurn(
  result: RawModelTurn,
  stream: ModelStreamSnapshot,
  options: ModelTurnInterpreterOptions,
): InterpretedModelTurn {
  const identity = {
    requestId: options.requestId,
    turn: options.turn,
    sayToolName: options.sayToolName,
  }

  if (result.type === 'tools') {
    if (result.calls.length === 0) {
      const text = result.text?.trim() ?? ''
      return text ? { type: 'final-text', text } : { type: 'empty' }
    }
    return {
      type: 'tool-batch',
      batch: normalizeNativeToolCalls(result.calls, identity, result.text),
    }
  }

  const visibleText = stream.sawThink ? stream.visibleText : result.text
  const textCalls = options.extractTextToolCalls(visibleText)
  if (textCalls.length > 0) {
    const assistantText = options.stripTextToolCalls(visibleText) || undefined
    return {
      type: 'tool-batch',
      batch: normalizeTextToolCalls(textCalls, identity, assistantText),
    }
  }

  return visibleText.trim()
    ? { type: 'final-text', text: visibleText }
    : { type: 'empty' }
}
