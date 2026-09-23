import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import { setCharacterOpacityWheelEnabled } from '../character/opacity'
import { STORAGE_CHARACTER_OPACITY } from '../constants'
import i18n from '../i18n'
import CharacterOpacityControl from './CharacterOpacityControl.vue'

function mountControl(initialOpacity = 0.8) {
  const Harness = defineComponent({
    setup() {
      const opacity = ref(initialOpacity)
      return () => h(CharacterOpacityControl, {
        opacity: opacity.value,
        'onUpdate:opacity': (value: number) => { opacity.value = value },
      })
    },
  })

  return mount(Harness, { global: { plugins: [i18n] } })
}

describe('CharacterOpacityControl', () => {
  beforeEach(() => localStorage.clear())

  it('调整滚轮和方向键透明度，并同步更新无障碍标签', async () => {
    const wrapper = mountControl()
    const button = wrapper.get('button')

    expect(button.attributes('aria-label')).toContain('80%')

    await button.trigger('wheel', { deltaY: -1 })
    expect(button.attributes('aria-label')).toContain('90%')
    expect(button.attributes('title')).toContain('90%')

    await button.trigger('keydown', { key: 'ArrowUp' })
    expect(button.attributes('aria-label')).toContain('100%')

    await button.trigger('keydown', { key: 'ArrowDown' })
    expect(button.attributes('aria-label')).toContain('90%')
    expect(localStorage.getItem(STORAGE_CHARACTER_OPACITY)).toBe('0.9')

    wrapper.unmount()
  })

  it('透明度到达上下限时保持合法值', async () => {
    const lowerBound = mountControl(0.2)
    const lowerButton = lowerBound.get('button')
    await lowerButton.trigger('keydown', { key: 'ArrowDown' })
    expect(lowerButton.attributes('aria-label')).toContain('20%')
    lowerBound.unmount()

    const upperBound = mountControl(1)
    const upperButton = upperBound.get('button')
    await upperButton.trigger('wheel', { deltaY: -1 })
    expect(upperButton.attributes('aria-label')).toContain('100%')
    expect(localStorage.getItem(STORAGE_CHARACTER_OPACITY)).toBe('1')
    upperBound.unmount()
  })

  it('悬浮滚轮关闭时仍响应工具栏显式调整，忽略无关按键', async () => {
    setCharacterOpacityWheelEnabled(false)
    const wrapper = mountControl()
    const button = wrapper.get('button')

    await button.trigger('keydown', { key: 'Enter' })
    expect(button.attributes('aria-label')).toContain('80%')

    await button.trigger('wheel', { deltaY: -1 })
    expect(button.attributes('aria-label')).toContain('90%')

    wrapper.unmount()
  })
})
