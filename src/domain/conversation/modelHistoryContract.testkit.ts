/**
 * 模型历史等价契约的共享夹具。
 *
 * 同一份会话事实一边实时追加到模型上下文，一边交给时间线投影恢复；
 * 测试只比较两边最终给模型的协议消息，不依赖 Vue、Pinia 或 Tauri。
 */
import type { ChatMessage } from '../../ai/types'
import { ChatContext } from '../../ai/context'
import { ChatContextModelContext } from '../../infrastructure/conversation/chatContextModelContext'
import type { ProtocolToolCall } from '../../application/conversation/toolCallBatch'
import type {
  ConversationSessionSnapshot,
  ModelContextMessage,
  RecordedToolCall,
} from './events'
import { SessionAggregate } from './sessionAggregate'

export const SAY_ACKNOWLEDGED = '已说出'

export interface ModelHistoryFixture {
  readonly session: SessionAggregate
  readonly realtime: ChatContextModelContext
  acceptUser(text: string, messageId?: string): void
  recordToolExchange(call: ProtocolToolCall, result?: string): void
  commitAssistant(input: {
    messageId: string
    display: string
    voice?: string
    source: 'say' | 'text-fallback'
  }): void
  realtimeHistory(): ModelContextMessage[]
  restoreHistory(): ModelContextMessage[]
  snapshot(): ConversationSessionSnapshot
}

function recordedCall(call: ProtocolToolCall): RecordedToolCall {
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(call.function.arguments || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
  } catch {
    // 事实投影只需保留协议调用的可投影参数；非法参数由执行路径另行记录。
  }
  return { id: call.id, name: call.function.name, arguments: args }
}

function protocolMessage(message: ChatMessage): ModelContextMessage | null {
  if (message.role === 'system') return null
  const content = typeof message.content === 'string' ? message.content : ''
  return {
    role: message.role,
    content,
    ...(message.tool_calls
      ? {
        toolCalls: message.tool_calls.map(call => ({
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),
        })),
      }
      : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function createModelHistoryFixture(): ModelHistoryFixture {
  const session = SessionAggregate.create({ id: 'session-1', title: '契约测试', now: 1 })
  // 测试夹具不读取应用配置，使用与领域投影相同的默认上下文。
  const realtime = new ChatContextModelContext(() => new ChatContext())
  let eventIndex = 0
  const identity = () => ({ eventId: `event-${++eventIndex}`, occurredAt: eventIndex })

  return {
    session,
    realtime,
    acceptUser(text, messageId = `user-${eventIndex + 1}`) {
      session.acceptUserMessage(identity(), { messageId, text, images: [] })
      realtime.addUserMessage(text, [])
    },
    recordToolExchange(call, result = SAY_ACKNOWLEDGED) {
      session.recordToolCalls(identity(), {
        stepId: `step-${eventIndex + 1}`,
        calls: [recordedCall(call)],
      })
      realtime.addToolCalls([call])
      session.recordToolResult(identity(), {
        callId: call.id,
        content: result,
        status: 'succeeded',
      })
      realtime.addToolResult(call.id, result)
    },
    commitAssistant(input) {
      session.commitAssistantMessage(identity(), input)
    },
    realtimeHistory() {
      return realtime.messages([]).map(protocolMessage).filter((message): message is ModelContextMessage => message !== null)
    },
    restoreHistory() {
      return SessionAggregate.restore(session.snapshot()).projectModelContext()
    },
    snapshot() {
      return session.snapshot()
    },
  }
}
