import { describe, expect, it } from 'vitest'
import type { ProtocolToolCall } from '../../application/conversation/toolCallBatch'
import {
  createModelHistoryFixture,
  SAY_ACKNOWLEDGED,
} from './modelHistoryContract.testkit'

function sayCall(id: string, display: string, voice = display): ProtocolToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'say',
      arguments: JSON.stringify({ voice, display }),
    },
  }
}

describe('模型历史等价契约', () => {
  it('同一段事实的实时累积与时间线恢复逐条产出相同协议消息', () => {
    const fixture = createModelHistoryFixture()

    fixture.acceptUser('先读取资料')
    const action: ProtocolToolCall = {
      id: 'read-1',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) },
    }
    fixture.recordToolExchange(action, '文件内容')
    fixture.recordToolExchange(sayCall('say-1', '读取完成'))
    fixture.commitAssistant({ messageId: 'assistant-1', display: '读取完成', voice: '读取完成', source: 'say' })

    fixture.acceptUser('再说一遍')
    fixture.recordToolExchange(sayCall('say-2', '好的'))
    fixture.commitAssistant({ messageId: 'assistant-2', display: '好的', source: 'text-fallback' })

    expect(fixture.restoreHistory()).toEqual(fixture.realtimeHistory())
  })

  it('普通 say 与纯文本兜底都锁定为 say 工具交换及固定回执', () => {
    const fixture = createModelHistoryFixture()

    fixture.acceptUser('普通 say')
    fixture.recordToolExchange(sayCall('say-native', '你好'))
    fixture.commitAssistant({ messageId: 'native-answer', display: '你好', source: 'say' })

    fixture.acceptUser('纯文本兜底')
    fixture.recordToolExchange(sayCall('say-fallback', '兜底回复'))
    fixture.commitAssistant({ messageId: 'fallback-answer', display: '兜底回复', source: 'text-fallback' })

    const history = fixture.restoreHistory()
    const calls = history.filter(message => message.role === 'assistant')
    expect(calls).toHaveLength(2)
    expect(calls.every(message => message.toolCalls?.[0]?.name === 'say')).toBe(true)
    expect(history.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([SAY_ACKNOWLEDGED, SAY_ACKNOWLEDGED])
  })

  it('v2 非空会话的恢复输入只来自时间线投影，不需要界面消息重放', () => {
    const fixture = createModelHistoryFixture()
    fixture.acceptUser('时间线中的用户消息')
    fixture.recordToolExchange(sayCall('say-1', '时间线中的助手消息'))
    fixture.commitAssistant({ messageId: 'assistant-1', display: '时间线中的助手消息', source: 'say' })

    const snapshot = fixture.snapshot()
    expect(snapshot.timeline.length).toBeGreaterThan(0)
    expect(snapshot).not.toHaveProperty('messages')
    expect(snapshot).not.toHaveProperty('context')
    expect(fixture.restoreHistory()).toEqual(fixture.realtimeHistory())
  })
})
