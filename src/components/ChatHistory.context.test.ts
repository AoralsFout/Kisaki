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

describe('ChatHistory 历史列表', () => {
  beforeEach(() => setActivePinia(createPinia()))

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

  it('用户消息头部行内提供回档控件', async () => {
    const { useChatStore } = await import('../stores/chat')
    const chat = useChatStore()
    chat.messages.push({ id: 'm1', role: 'user', text: '问', timestamp: 0 })

    const wrapper = mount(ChatHistory, {
      props: { visible: true },
      global: { stubs: { Transition: false } },
    })

    const header = wrapper.get('.item-header')
    expect(header.find('.msg-rollback .rb-btn').exists()).toBe(true)
    expect(header.get('.msg-role-label').text()).toContain('chat.history.you')
  })

  it('对话框弹出时容器进入展开态，生成中以待完成项显示流式回复', async () => {
    const { useChatStore } = await import('../stores/chat')
    const chat = useChatStore()
    chat.isProcessing = true
    chat.currentBubbleText = '正在生成的内容'
    chat.showInput = true

    const wrapper = mount(ChatHistory, {
      props: { visible: true },
      global: { stubs: { Transition: false } },
    })

    expect(wrapper.get('.chat-history').classes()).toContain('expanded')
    expect(wrapper.get('.pending').text()).toContain('正在生成的内容')

    chat.isProcessing = false
    chat.showInput = false
  })
})
