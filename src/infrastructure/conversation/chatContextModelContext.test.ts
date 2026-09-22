import { describe, expect, it } from 'vitest'
import { ChatContext } from '../../ai/context'
import type { ChatMessage } from '../../ai/types'
import type { ToolDefinition } from '../../agent/types'
import type { ConversationImage } from '../../domain/conversation/events'
import type { ModelContextMessage } from '../../domain/conversation/events'
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
  it('裁剪生成滚动摘要时通知会话事实，且重复读取不会重复通知', () => {
    const compactions: { summary: string; summarizedRounds: number }[] = []
    const context = new ChatContextModelContext(
      () => new ChatContext({ maxRounds: 1, maxContextTokens: 6000 }),
      compaction => compactions.push(compaction),
    )
    context.addUserMessage('较早的问题', [])
    context.addToolCalls([SAY_CALL])
    context.addToolResult(SAY_CALL.id, '较早的结果')
    context.addUserMessage('当前的问题', [])

    context.messages([])
    context.messages([])

    expect(compactions).toHaveLength(1)
    expect(compactions[0].summary).toContain('较早的问题')
    expect(compactions[0].summarizedRounds).toBe(1)
  })

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

  it('直接装载时间线模型投影，保留图片、工具交换与滚动摘要', () => {
    const context = new ChatContextModelContext(trackingFactory().create)
    context.setSystemPrompt('你是小崎')
    const projection: ModelContextMessage[] = [
      { role: 'system', content: '较早回合摘要' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张' },
          { type: 'image_url', image_url: { url: IMAGE.dataUrl, detail: 'auto' } },
        ],
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'say-1', name: 'say', arguments: { voice: '你好', display: '你好' } }],
      },
      { role: 'tool', content: '已说出', toolCallId: 'say-1' },
    ]

    context.loadModelProjection(projection, { summarizedRounds: 1 })
    const messages = context.messages([])

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: projection[1].content }),
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({
        id: 'say-1',
        function: expect.objectContaining({ arguments: '{"voice":"你好","display":"你好"}' }),
      })] }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'say-1', content: '已说出' }),
    ]))
    expect(messages[1].content).toContain('较早回合摘要')
    expect(context.stats().summarizedRounds).toBe(1)
  })

  it('inspect() 给出检查器视图且不改动统计状态', () => {
    const context = new ChatContextModelContext(trackingFactory().create)
    context.addUserMessage('你好', [])
    const before = context.stats()

    expect(context.inspect([]).messages.length).toBeGreaterThan(0)
    expect(context.stats()).toEqual(before)
  })
})
