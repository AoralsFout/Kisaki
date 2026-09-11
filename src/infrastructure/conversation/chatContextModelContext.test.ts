import { describe, expect, it } from 'vitest'
import { ChatContext } from '../../ai/context'
import type { ChatMessage } from '../../ai/types'
import type { ToolDefinition } from '../../agent/types'
import type { ConversationImage } from '../../domain/conversation/events'
import type { ProtocolToolCall } from '../../application/conversation/toolCallBatch'
import { ChatContextModelContext } from './chatContextModelContext'

const SAY_TOOL: ToolDefinition = {
  type: 'function',
  function: { name: 'say', description: '说出台词', parameters: {} },
}

const SAY_CALL: ProtocolToolCall = {
  id: 'call-1',
  type: 'function',
  function: { name: 'say', arguments: '{"display":"你好"}' },
}

const IMAGE: ConversationImage = {
  id: 'img-1',
  name: 'a.png',
  mimeType: 'image/png',
  size: 12,
  dataUrl: 'data:image/png;base64,AA==',
}

/** 记录每次建出的底层上下文，用来断言替换确实发生了。 */
function trackingFactory() {
  const created: ChatContext[] = []
  return {
    created,
    create: () => {
      const context = new ChatContext()
      created.push(context)
      return context
    },
  }
}

function textsOf(messages: readonly ChatMessage[]): string[] {
  return messages
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .filter(Boolean)
}

describe('ChatContextModelContext', () => {
  it('构造时按工厂建出一个底层上下文', () => {
    const tracking = trackingFactory()

    new ChatContextModelContext(tracking.create)

    expect(tracking.created).toHaveLength(1)
  })

  it('messages() 转发底层上下文并带上工具定义预算', () => {
    const tracking = trackingFactory()
    const context = new ChatContextModelContext(tracking.create)
    context.addUserMessage('你好', [])

    expect(textsOf(context.messages([]))).toContain('你好')
    expect(context.stats().toolDefinitionTokens).toBe(0)

    context.messages([SAY_TOOL])

    expect(context.stats().toolDefinitionTokens).toBeGreaterThan(0)
  })

  it('追加工具调用、结果与图片都落在同一个底层上下文上', () => {
    const tracking = trackingFactory()
    const context = new ChatContextModelContext(tracking.create)

    context.addToolCalls([SAY_CALL], '可见正文')
    context.addToolResult(SAY_CALL.id, '工具结果')
    context.addToolImages(SAY_CALL.id, [IMAGE])
    const messages = context.messages([])

    expect(messages.some(message => message.role === 'assistant'
      && message.content === '可见正文'
      && message.tool_calls?.[0].id === SAY_CALL.id)).toBe(true)
    expect(messages.some(message => message.role === 'tool'
      && message.tool_call_id === SAY_CALL.id
      && message.content === '工具结果')).toBe(true)
    expect(messages.some(message => message.role === 'user' && Array.isArray(message.content))).toBe(true)
  })

  it('stats() 就是底层上下文的统计', () => {
    const tracking = trackingFactory()
    const context = new ChatContextModelContext(tracking.create)
    context.addUserMessage('你好', [])
    context.messages([SAY_TOOL])

    expect(context.stats()).toEqual(tracking.created[0].getStats())
  })

  it('reset() 按工厂换一个新的空上下文，旧内容不保留', () => {
    const tracking = trackingFactory()
    const context = new ChatContextModelContext(tracking.create)
    context.addUserMessage('你好', [])

    context.reset()

    expect(tracking.created).toHaveLength(2)
    expect(tracking.created[1]).not.toBe(tracking.created[0])
    expect(textsOf(context.messages([]))).not.toContain('你好')

    // 替换之后写入必须落到新的底层上下文，而不是旧的那份。
    context.addUserMessage('再见', [])
    expect(textsOf(context.messages([]))).toContain('再见')
  })

  it('快照往返在天生的上下文替换之后恢复内容', () => {
    const tracking = trackingFactory()
    const context = new ChatContextModelContext(tracking.create)
    context.setSystemPrompt('你是小崎')
    context.addUserMessage('你好', [])
    const snapshot = context.snapshot()

    context.reset()
    expect(textsOf(context.messages([]))).not.toContain('你好')

    context.setSystemPrompt('你是小崎')
    expect(context.restore(snapshot)).toBe(true)
    expect(textsOf(context.messages([]))).toContain('你好')
    expect(textsOf(context.messages([])).some(text => text.includes('你是小崎'))).toBe(true)
  })

  it('拒绝来路不明的快照时返回 false，不抛错', () => {
    const context = new ChatContextModelContext(trackingFactory().create)
    // 版本号对不上时应当整份丢弃，而不是尽力而为地恢复一半。
    const stale = JSON.parse('{"version":99,"messages":[],"rollingSummary":"","summarizedRounds":0}')

    expect(context.restore(null)).toBe(false)
    expect(context.restore(stale)).toBe(false)
  })

  it('restoreUserImages() 把界面历史里的图片配回用户消息', () => {
    const context = new ChatContextModelContext(trackingFactory().create)
    context.addUserMessage('看这张', [])

    context.restoreUserImages([{ text: '看这张', images: [IMAGE] }])

    const userMessage = context.messages([]).find(message => message.role === 'user' && Array.isArray(message.content))
    expect(userMessage).toBeDefined()
  })

  it('inspect() 给出检查器视图且不改动统计状态', () => {
    const context = new ChatContextModelContext(trackingFactory().create)
    context.addUserMessage('你好', [])
    const before = context.stats()

    expect(context.inspect([]).messages.length).toBeGreaterThan(0)
    expect(context.stats()).toEqual(before)
  })
})
