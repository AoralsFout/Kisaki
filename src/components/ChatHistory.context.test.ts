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
})
