import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationDock from './ConversationDock.vue'

function rect(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 400,
    height,
    top: 0,
    right: 400,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  }
}

describe('ConversationDock', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('用同一组最终高度协调输入区移出与历史区展开', async () => {
    let inputHeight = 200
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-dock')) return rect(700)
      if (this.classList.contains('dock-before')) return rect(40)
      if (this.classList.contains('dock-after')) return rect(60)
      if (this.classList.contains('dock-input')) return rect(inputHeight)
      return rect(0)
    })

    const wrapper = mount(ConversationDock, {
      attachTo: document.body,
      props: { expanded: false, latestMessageHeight: 120, layoutKey: 'session-a' },
      slots: {
        before: '<div>before</div>',
        after: '<div>after</div>',
        input: '<div>input</div>',
      },
    })
    await flushPromises()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 200px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 120px')

    await wrapper.setProps({ expanded: true })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 0px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 400px')

    inputHeight = 260
    window.dispatchEvent(new Event('resize'))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 340px')

    await wrapper.setProps({ layoutKey: 'session-b' })
    expect(wrapper.get('.conversation-dock').classes()).toContain('is-settling')
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    expect(wrapper.get('.conversation-dock').classes()).not.toContain('is-settling')

    wrapper.unmount()
  })

  it('通过作用域插槽把折叠容量和溢出状态交给历史组件', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-dock')) return rect(300)
      if (this.classList.contains('dock-before')) return rect(40)
      if (this.classList.contains('dock-after')) return rect(60)
      if (this.classList.contains('dock-input')) return rect(100)
      return rect(0)
    })

    const wrapper = mount(ConversationDock, {
      props: { expanded: false, latestMessageHeight: 444 },
      slots: {
        history: ({ collapsedHeight, latestOverflowing }: {
          collapsedHeight: number
          latestOverflowing: boolean
        }) => h('output', { class: 'layout-result' }, `${collapsedHeight}:${latestOverflowing}`),
      },
    })
    await flushPromises()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    expect(wrapper.get('.layout-result').text()).toBe('200:true')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 200px')

    wrapper.unmount()
  })
})
