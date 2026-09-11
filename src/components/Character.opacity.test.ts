import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import Character from './Character.vue'

describe('Character opacity control', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('updates the shared renderer opacity immediately and emits persisted wheel changes', async () => {
    const wrapper = mount(Character, {
      props: { opacity: 0.8 },
      global: {
        stubs: {
          IllustrationStage: { template: '<div />' },
          Live2DStage: { template: '<div />' },
        },
      },
    })

    const renderer = wrapper.get<HTMLElement>('.character-renderer')
    expect(renderer.element.style.opacity).toBe('0.8')

    await renderer.trigger('wheel', { deltaY: -1 })
    expect(wrapper.emitted('update:opacity')?.slice(-1)[0]).toEqual([0.9])

    await wrapper.setProps({ opacity: 0.9 })
    expect(renderer.element.style.opacity).toBe('0.9')
    wrapper.unmount()
  })

  it('keeps the hover-wheel setting separate from explicit opacity controls', async () => {
    const { setCharacterOpacityWheelEnabled, adjustCharacterOpacity } = await import('../character/opacity')
    setCharacterOpacityWheelEnabled(false)
    const wrapper = mount(Character, {
      props: { opacity: 0.8 },
      global: {
        stubs: {
          IllustrationStage: { template: '<div />' },
          Live2DStage: { template: '<div />' },
        },
      },
    })

    const renderer = wrapper.get<HTMLElement>('.character-renderer')
    await renderer.trigger('wheel', { deltaY: -1 })
    expect(wrapper.emitted('update:opacity')).toBeUndefined()
    // 工具栏的显式路径直接调用共享辅助函数，不受该设置开关限制。
    expect(adjustCharacterOpacity(0.8, -1)).toBe(0.9)
    wrapper.unmount()
  })
})
