/**
 * 对话 store 的薄测试：只验证两件事 ——
 * 投影被写进响应式状态，用户动作被转发成 `send` / `cancel`。
 *
 * 业务规则（守卫顺序、取消语义、终态分类、say 让位……）不在这里测，
 * 它们的测试面是 `src/application/conversation/conversationSession.test.ts`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, type Pinia } from 'pinia'
import {
  actionTurn,
  createConversationHarness,
  sayTurn,
  type ConversationHarness,
} from '../../application/conversation/conversationSession.testkit'
import { ChatContextModelContext } from '../../infrastructure/conversation/chatContextModelContext'
import type { ConversationAssembly } from '../../compositionRoot'
import type { useChatStore as UseChatStore } from '../chat'

/** 工具活动列表的淡出时长；与 store 内的常量同值。 */
const TOOL_ACTIVITY_FADE_MS = 5000

const { assemblyRef } = vi.hoisted(() => ({
  assemblyRef: { current: null as unknown as ConversationAssembly },
}))

vi.mock('../../compositionRoot', () => ({
  conversationAssembly: () => {
    if (!assemblyRef.current) throw new Error('组合根尚未装配对话回合：composeApplication() 未执行')
    return assemblyRef.current
  },
}))

let pinia: Pinia
let h: ConversationHarness
type ChatStore = ReturnType<typeof UseChatStore>

/** 把一段回合编排接到 store 上；返回的 harness 供用例驱动模型与观察端口。 */
function assemble(harness: ConversationHarness): void {
  assemblyRef.current = {
    ports: harness.ports,
    session: harness.session,
    context: new ChatContextModelContext(),
    approvalGateway: harness.toolExecution.gateway,
  }
}

async function chatStore(): Promise<ChatStore> {
  const { useChatStore } = await import('../chat')
  return useChatStore(pinia)
}

beforeEach(() => {
  pinia = createPinia()
  h = createConversationHarness()
  assemble(h)
})

describe('ChatStore 作为投影', () => {
  it('把会话投影逐字段写进响应式状态，派生量由回合计状态得出', async () => {
    const store = await chatStore()
    const duringToolTurn: { processing: boolean; usingTools: boolean }[] = []
    h.toolExecution.prepare = async call => {
      duringToolTurn.push({ processing: store.isProcessing, usingTools: store.isUsingTools })
      return { call }
    }
    h.context.statsValue = { ...h.context.statsValue, estimatedTokens: 123 }
    h.model.enqueue(actionTurn('read_file'))
    h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))

    expect(await store.sendMessage('hi')).toBe(true)

    // 工具执行那一刻的派生量：处理中 + 正在使用工具。
    expect(duringToolTurn).toEqual([{ processing: true, usingTools: true }])
    // 终态：投影推进到 completed，气泡与思考归位，统计来自端口。
    expect(store.conversationRunState).toBe('completed')
    expect(store.isProcessing).toBe(false)
    expect(store.isUsingTools).toBe(false)
    expect(store.currentBubbleText).toBe('你好')
    expect(store.currentThinking).toBe('')
    expect(store.contextStats.estimatedTokens).toBe(123)
    // 界面消息列表来自已提交消息事件，而不是投影。
    expect(store.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'hi'],
      ['assistant', '你好'],
    ])
  })

  it('工具活动列表：新活动点亮，回合自然结束后 5 秒淡出', async () => {
    vi.useFakeTimers()
    try {
      const store = await chatStore()
      h.model.enqueue(actionTurn('read_file'))
      h.model.enqueue(sayTurn('say-after-tool', { display: '完成' }))

      expect(await store.sendMessage('hi')).toBe(true)
      expect(store.toolActivities.map(activity => activity.status)).toEqual(['done'])
      expect(store.showToolActivity).toBe(true)

      await vi.advanceTimersByTimeAsync(TOOL_ACTIVITY_FADE_MS)
      expect(store.showToolActivity).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('空的活动列表立即隐藏，不留淡出计时', async () => {
    const store = await chatStore()
    h.model.enqueue(sayTurn('say-1', { display: '你好' }))

    expect(await store.sendMessage('hi')).toBe(true)
    expect(store.toolActivities).toEqual([])
    expect(store.showToolActivity).toBe(false)
  })
})

describe('ChatStore 作为命令转发者', () => {
  it('sendMessage 把输入原样交给会话', async () => {
    const store = await chatStore()
    const send = vi.spyOn(h.session, 'send')
    h.model.enqueue(sayTurn('say-1', { display: '你好' }))

    expect(await store.sendMessage('  你好  ')).toBe(true)
    expect(send).toHaveBeenCalledWith({ text: '  你好  ', images: [] })
  })

  it('用户动作各自转发为一条带原因的取消', async () => {
    const store = await chatStore()
    const cancel = vi.spyOn(h.session, 'cancel')

    store.cancelResponse()
    expect(cancel).toHaveBeenLastCalledWith('user-cancelled')

    store.resetContext()
    expect(cancel).toHaveBeenLastCalledWith('context-reset')

    store.clearMessages()
    expect(cancel).toHaveBeenLastCalledWith('messages-cleared')

    store.refreshModelContext()
    expect(cancel).toHaveBeenLastCalledWith('model-context-refreshed')
  })

  it('返回值映射：取消算已接受，触达轮次上限不算', async () => {
    const store = await chatStore()
    h.model.enqueue(sayTurn('say-1', { display: '你好' }))
    const sending = store.sendMessage('hi')
    store.cancelResponse()
    expect(await sending).toBe(true)

    // 轮次上限：模型一直调工具、始终不交付回复。
    // 换一个 Pinia 才能拿到重新订阅到新会话的 store 实例。
    const limited = createConversationHarness({ maxToolTurns: 1 })
    assemble(limited)
    pinia = createPinia()
    const limitedStore = await chatStore()
    limited.model.enqueue(actionTurn('read_file'))
    expect(await limitedStore.sendMessage('hi')).toBe(false)
    expect(limitedStore.messages.filter(message => message.role === 'assistant')).toHaveLength(0)
  })
})
