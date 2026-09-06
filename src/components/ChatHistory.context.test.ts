import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => { document.body.innerHTML = '' })

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
    wrapper.unmount()
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
    wrapper.unmount()
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
    wrapper.unmount()
  })

  it('图片缩略图可用键盘聚焦并打开带焦点管理的大图查看器', async () => {
    const { useChatStore } = await import('../stores/chat')
    const chat = useChatStore()
    chat.messages.push({
      id: 'm-image', role: 'user', text: '图片', timestamp: 0,
      images: [{ id: 'img-1', name: 'sample.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AA==' }],
    })
    const wrapper = mount(ChatHistory, { attachTo: document.body, props: { visible: true } })
    const thumbnail = wrapper.get<HTMLButtonElement>('.msg-image-button')
    thumbnail.element.focus()
    await thumbnail.trigger('click')
    await flushPromises()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('chat.history.imageViewerTitle')
    expect(document.activeElement).toBe(dialog.querySelector('.lightbox-close'))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.lightbox')).toBeNull()
    expect(document.activeElement).toBe(thumbnail.element)
    wrapper.unmount()
  })

  it('切换会话时直接跳到底部，同一会话的新消息才平滑滚动', async () => {
    const { useChatStore } = await import('../stores/chat')
    const { useSessionStore } = await import('../stores/session')
    const chat = useChatStore()
    const sessions = useSessionStore()
    sessions.currentSessionId = 'session-a'
    chat.messages.push({ id: 'm-a', role: 'assistant', text: 'A', timestamp: 0 })

    const wrapper = mount(ChatHistory, { props: { visible: true } })
    const list = wrapper.get<HTMLElement>('.message-list').element
    const scrollTo = vi.fn()
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isTargetMessage = this.classList.contains('history-item')
        && this.querySelector('.msg-text')?.textContent === 'B'
      const height = isTargetMessage ? 126 : 40
      return { x: 0, y: 0, width: 300, height, top: 0, right: 300, bottom: height, left: 0, toJSON: () => ({}) }
    })
    Object.defineProperty(list, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 500 })
    await flushPromises()
    scrollTo.mockClear()

    // 两个会话消息数相同也必须由 session id 变化触发瞬时定位。
    sessions.currentSessionId = 'session-b'
    chat.messages.splice(0, 1, { id: 'm-b', role: 'assistant', text: 'B', timestamp: 1 })
    await flushPromises()
    expect(scrollTo).toHaveBeenCalled()
    expect(scrollTo.mock.calls.every(([options]) => options.behavior === 'auto')).toBe(true)
    expect(wrapper.get('.chat-history').attributes('style')).toContain('--collapsed-h: 126px')
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    scrollTo.mockClear()
    chat.messages.push({ id: 'm-b2', role: 'assistant', text: 'B2', timestamp: 2 })
    await flushPromises()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' })
    rectSpy.mockRestore()
    wrapper.unmount()
  })
})
