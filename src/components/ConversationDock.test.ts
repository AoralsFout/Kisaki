import { flushPromises, mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationDock from './ConversationDock.vue'

function controlAnimationFrames() {
  let nextId = 1
  const pending = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId++
    pending.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    pending.delete(id)
  })
  return {
    frame() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback(performance.now())
    },
  }
}

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = []
  readonly callback: ResizeObserverCallback
  readonly observed = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element) { this.observed.add(target) }
  unobserve(target: Element) { this.observed.delete(target) }
  disconnect() { this.observed.clear() }
  notify() { this.callback([], this) }
}

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
    vi.unstubAllGlobals()
    TestResizeObserver.instances = []
    document.body.innerHTML = ''
  })

  it('首次测量后才启用过渡，并把实际测量结果交给历史插槽', async () => {
    const frames = controlAnimationFrames()
    const sizes = { container: 640, before: 40, after: 60, input: 180 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-dock')) return rect(sizes.container)
      if (this.classList.contains('dock-before')) return rect(sizes.before)
      if (this.classList.contains('dock-after')) return rect(sizes.after)
      if (this.classList.contains('dock-input')) return rect(sizes.input)
      return rect(0)
    })

    const wrapper = mount(ConversationDock, {
      props: { expanded: false, latestMessageHeight: 420 },
      slots: {
        before: '<div>toolbar</div>',
        after: '<div>status</div>',
        input: '<div>composer</div>',
        history: ({ collapsedHeight, latestOverflowing }: {
          collapsedHeight: number
          latestOverflowing: boolean
        }) => h('output', { class: 'layout-result' }, `${collapsedHeight}:${latestOverflowing}`),
      },
    })
    await flushPromises()
    await nextTick()

    expect(wrapper.get('.conversation-dock').classes()).not.toContain('is-ready')
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 180px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 420px')
    expect(wrapper.get('.layout-result').text()).toBe('420:false')

    frames.frame()
    await nextTick()
    expect(wrapper.get('.conversation-dock').classes()).toContain('is-ready')
    wrapper.unmount()
  })

  it('尺寸观察更新折叠容量、溢出与展开高度，零尺寸仍产生有限非负布局', async () => {
    const frames = controlAnimationFrames()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const sizes = { container: 640, before: 40, after: 60, input: 180 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-dock')) return rect(sizes.container)
      if (this.classList.contains('dock-before')) return rect(sizes.before)
      if (this.classList.contains('dock-after')) return rect(sizes.after)
      if (this.classList.contains('dock-input')) return rect(sizes.input)
      return rect(0)
    })

    const wrapper = mount(ConversationDock, {
      props: { expanded: false, latestMessageHeight: 420 },
      slots: {
        history: ({ collapsedHeight, latestOverflowing }: {
          collapsedHeight: number
          latestOverflowing: boolean
        }) => h('output', { class: 'layout-result' }, `${collapsedHeight}:${latestOverflowing}`),
      },
    })
    await flushPromises()
    await nextTick()
    frames.frame()
    await nextTick()

    sizes.container = 500
    sizes.before = 60
    sizes.after = 40
    sizes.input = 200
    TestResizeObserver.instances[0].notify()
    frames.frame()
    await nextTick()
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 200px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 400px')
    expect(wrapper.get('.layout-result').text()).toBe('400:true')

    await wrapper.setProps({ expanded: true })
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 0px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 200px')
    expect(wrapper.get('.layout-result').text()).toBe('400:true')

    sizes.container = 0
    sizes.before = 0
    sizes.after = 0
    sizes.input = 0
    await wrapper.setProps({ expanded: false, latestMessageHeight: 0 })
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 0px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 0px')
    expect(wrapper.get('.layout-result').text()).toBe('0:false')
    expect(wrapper.get('.dock-track').attributes('style')).not.toMatch(/NaN|Infinity|-\d/)

    wrapper.unmount()
  })

  it('快速连续切换会话时以最后一次测量结果结束过渡', async () => {
    const frames = controlAnimationFrames()
    const sizes = { container: 500, before: 50, after: 30, input: 120 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-dock')) return rect(sizes.container)
      if (this.classList.contains('dock-before')) return rect(sizes.before)
      if (this.classList.contains('dock-after')) return rect(sizes.after)
      if (this.classList.contains('dock-input')) return rect(sizes.input)
      return rect(0)
    })
    const wrapper = mount(ConversationDock, {
      props: { expanded: false, latestMessageHeight: 80, layoutKey: 'session-a' },
      slots: {
        history: ({ collapsedHeight, latestOverflowing }: {
          collapsedHeight: number
          latestOverflowing: boolean
        }) => h('output', { class: 'layout-result' }, `${collapsedHeight}:${latestOverflowing}`),
      },
    })
    await flushPromises()
    await nextTick()
    frames.frame()
    await nextTick()

    sizes.container = 800
    sizes.before = 100
    sizes.after = 50
    sizes.input = 200
    await wrapper.setProps({ layoutKey: 'session-b', latestMessageHeight: 700 })
    expect(wrapper.get('.conversation-dock').classes()).toContain('is-settling')
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 200px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 650px')
    expect(wrapper.get('.layout-result').text()).toBe('650:true')

    sizes.container = 600
    sizes.before = 30
    sizes.after = 20
    sizes.input = 150
    await wrapper.setProps({ layoutKey: 'session-c', latestMessageHeight: 260 })
    expect(wrapper.get('.conversation-dock').classes()).toContain('is-settling')
    expect(wrapper.get('.dock-track').attributes('style')).toContain('--input-drop: 150px')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 260px')
    expect(wrapper.get('.layout-result').text()).toBe('260:false')

    frames.frame()
    await nextTick()
    expect(wrapper.get('.conversation-dock').classes()).not.toContain('is-settling')
    expect(wrapper.get('.dock-history').attributes('style')).toContain('--history-height: 260px')
    expect(wrapper.get('.layout-result').text()).toBe('260:false')
    wrapper.unmount()
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
