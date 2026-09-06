import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import ChatHistory from './ChatHistory.vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

describe('ChatHistory 上下文状态', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('显示上下文预算、使用量和摘要轮数', async () => {
    const { useChatStore } = await import('../stores/chat')
    const chat = useChatStore()
    chat.contextStats = {
      estimatedTokens: 12_500,
      maxContextTokens: 32_000,
      toolDefinitionTokens: 4_000,
      messageCount: 20,
      summarizedRounds: 3,
      prunedMessages: 9,
      utilization: 12_500 / 32_000,
    }

    const wrapper = mount(ChatHistory, {
      props: { visible: true },
      global: { stubs: { Transition: false } },
    })

    const status = wrapper.get('.context-status')
    expect(status.text()).toContain('13k/32k')
    expect(status.text()).toContain('chat.history.summarized')
    expect(status.attributes('title')).toContain('"tools":4000')
    expect(wrapper.get('.context-meter i').attributes('style')).toContain('39%')
  })

  it('助手消息优先显示身份快照名称，旧数据回退当前角色', async () => {
    const { useChatStore } = await import('../stores/chat')
    const chat = useChatStore()
    chat.messages.push(
      { id: 'm1', role: 'assistant', text: '带快照', timestamp: 0, charId: 'old', charName: '旧角色' },
      { id: 'm2', role: 'assistant', text: '无快照', timestamp: 0 },
      { id: 'm3', role: 'user', text: '问', timestamp: 0 },
    )

    const wrapper = mount(ChatHistory, {
      props: { visible: true },
      global: { stubs: { Transition: false } },
    })

    const labels = wrapper.findAll('.msg-role-label').map(l => l.text())
    expect(labels[0]).toContain('旧角色')
    // 旧数据无快照：回退当前角色名，最终兜底为品牌名 Kisaki
    expect(labels[1].toLowerCase()).toContain('kisaki')
    expect(labels[2]).toContain('chat.history.you')
  })

  it('面板头部展示当前会话标题，清空按钮在生成中锁定', async () => {
    const { useChatStore } = await import('../stores/chat')
    const { useSessionStore } = await import('../stores/session')
    const chat = useChatStore()
    chat.isProcessing = true

    // 填充当前会话（真实 session store 状态）
    const sessionStore = useSessionStore()
    sessionStore.sessions = [{ id: 's1', name: 'Named session', messages: [], createdAt: 0, updatedAt: 0 }] as any
    sessionStore.currentSessionId = 's1'

    const wrapper = mount(ChatHistory, {
      props: { visible: true },
      global: { stubs: { Transition: false } },
    })

    expect(wrapper.get('.session-name').text()).toBe('Named session')
    expect(wrapper.get('.btn-clear').attributes('disabled')).toBeDefined()

    chat.isProcessing = false
  })
})
