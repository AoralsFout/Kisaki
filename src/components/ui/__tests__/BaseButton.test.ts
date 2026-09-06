import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BaseButton from '../BaseButton.vue'

describe('BaseButton', () => {
  it('renders primary variant by default and forwards clicks', async () => {
    const wrapper = mount(BaseButton, { slots: { default: '保存' } })
    expect(wrapper.classes()).toContain('btn')
    expect(wrapper.classes()).toContain('btn-primary')
    expect(wrapper.text()).toBe('保存')
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('supports secondary and danger variants', () => {
    const secondary = mount(BaseButton, { props: { variant: 'secondary' } })
    expect(secondary.classes()).toContain('btn-secondary')
    const danger = mount(BaseButton, { props: { variant: 'danger' } })
    expect(danger.classes()).toContain('btn-danger')
  })

  it('disables via the disabled prop', () => {
    const wrapper = mount(BaseButton, { props: { disabled: true } })
    expect(wrapper.attributes('disabled')).toBeDefined()
  })
})
