import { describe, expect, it } from 'vitest'
import { inspectSavedSession } from './contextInspector'
import type { ModelContextMessage } from './domain/conversation/events'

describe('contextInspector saved session', () => {
  it('明确标记持久化快照，并把滚动摘要放在协议历史之前', () => {
    const inspected = inspectSavedSession({
      id: 'session-1',
      name: '已保存会话',
      messages: [],
      updatedAt: 123,
      context: {
        version: 1,
        rollingSummary: '- 用户：旧问题',
        summarizedRounds: 2,
        messages: [{ role: 'user', content: '当前问题' }],
      },
    })

    expect(inspected.source).toBe('saved')
    expect(inspected.isCurrent).toBe(false)
    expect(inspected.messages.map(message => message.origin)).toEqual(['summary', 'summary', 'history'])
    expect(inspected.messages[2].content).toBe('当前问题')
    expect(inspected.stats.summarizedRounds).toBe(2)
    expect(inspected.toolDefinitions).toEqual([])
    expect(inspected.persona).toBeNull()
  })

  it('保存会话的模型图片投影在检查器中只显示元数据', () => {
    const modelContext: ModelContextMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD', detail: 'auto' } },
      ],
    }]

    const inspected = inspectSavedSession({
      id: 'session-2',
      name: '含图片会话',
      messages: [],
      modelContext,
      updatedAt: 123,
    })

    const content = inspected.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(JSON.stringify(content)).not.toContain('QUJD')
    expect(JSON.stringify(content)).toContain('embedded image: image/png')
    expect(modelContext[0].content).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD', detail: 'auto' } },
    ])
  })
})
