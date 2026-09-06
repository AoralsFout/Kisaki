import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import InputBox from './InputBox.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('InputBox 头部与上下文圆环', () => {
  it('头部显示传入的会话标题，无标题时回退通用文案', () => {
    const named = mount(InputBox, { props: { visible: true, title: '日常闲聊' } })
    expect(named.get('.input-title').text()).toContain('日常闲聊')

    const fallback = mount(InputBox, { props: { visible: true } })
    expect(fallback.get('.input-title').text()).toContain('chat.input.title')
  })

  it('提供上下文占用时渲染圆环并悬浮展示详情；未提供时不渲染', () => {
    const withRing = mount(InputBox, {
      props: { visible: true, contextUtilization: 0.39, contextDetail: '详情文本' },
    })
    const ring = withRing.get('.context-ring')
    expect(ring.attributes('aria-label')).toBe('详情文本')
    expect(ring.attributes('tabindex')).toBe('0')
    expect(ring.text()).toContain('39%')
    // 快捷键提示已移除，为底栏腾出空间
    expect(withRing.find('.hint').exists()).toBe(false)

    const noRing = mount(InputBox, { props: { visible: true } })
    expect(noRing.find('.context-ring').exists()).toBe(false)
  })

  it('折叠后保留草稿 DOM 但从键盘与辅助技术中隐藏', () => {
    const wrapper = mount(InputBox, { props: { visible: false } })
    const overlay = wrapper.get('.input-overlay')
    expect(overlay.attributes('inert')).toBeDefined()
    expect(overlay.attributes('aria-hidden')).toBe('true')
  })
})
