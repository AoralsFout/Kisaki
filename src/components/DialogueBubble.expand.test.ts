import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import DialogueBubble from './DialogueBubble.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../stores/language', () => ({ getTypingSpeed: () => 1 }))

describe('DialogueBubble 长回复展开', () => {
  it('短回复不出现展开按钮，长回复可展开/收起', async () => {
    const wrapper = mount(DialogueBubble, { props: { text: '短回复', visible: true, typing: false } })
    expect(wrapper.find('.bubble-toggle').exists()).toBe(false)

    await wrapper.setProps({ text: '啊'.repeat(200) })
    expect(wrapper.find('.bubble-toggle').exists()).toBe(true)
    expect(wrapper.find('.bubble-body').classes()).not.toContain('expanded')
    expect(wrapper.find('.bubble-body').classes()).toContain('light')

    await wrapper.find('.bubble-toggle').trigger('click')
    expect(wrapper.find('.bubble-body').classes()).toContain('expanded')
    expect(wrapper.find('.bubble-toggle').attributes('aria-expanded')).toBe('true')

    await wrapper.find('.bubble-toggle').trigger('click')
    expect(wrapper.find('.bubble-body').classes()).not.toContain('expanded')
  })

  it('打字中点击气泡跳过动画，不触发展开；文本更新后展开态复位', async () => {
    const wrapper = mount(DialogueBubble, { props: { text: '', visible: true, typing: true } })
    await wrapper.setProps({ text: '啊'.repeat(200) })
    // 打字动画进行中（speed=1ms，等待若干增量后仍应有光标）
    expect(wrapper.find('.bubble-body').classes()).not.toContain('expanded')

    // 跳过打字
    await wrapper.find('.bubble-body').trigger('click')
    expect(wrapper.find('.bubble-toggle').exists()).toBe(true)

    // 收起态下更新文本：展开状态复位
    await wrapper.find('.bubble-toggle').trigger('click')
    expect(wrapper.find('.bubble-body').classes()).toContain('expanded')
    await wrapper.setProps({ text: '新的一句话' })
    expect(wrapper.find('.bubble-body').classes()).not.toContain('expanded')
  })
})
