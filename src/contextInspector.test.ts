import { describe, expect, it } from 'vitest'
import { inspectSavedSession } from './contextInspector'

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
})
