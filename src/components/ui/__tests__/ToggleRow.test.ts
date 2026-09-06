import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToggleRow from '../ToggleRow.vue'

describe('ToggleRow', () => {
  it('renders title and description with switch state', () => {
    const wrapper = mount(ToggleRow, { props: { title: '自动执行', desc: '说明文字', checked: true } })
    expect(wrapper.text()).toContain('自动执行')
    expect(wrapper.text()).toContain('说明文字')
    expect(wrapper.get('[role="switch"]').classes()).toContain('active')
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[role="switch"]').attributes('aria-labelledby')).toBe(wrapper.get('.toggle-label-text').attributes('id'))
    expect(wrapper.get('[role="switch"]').attributes('aria-describedby')).toBe(wrapper.get('.toggle-label-desc').attributes('id'))
  })

  it('emits update:checked with the next value', async () => {
    const wrapper = mount(ToggleRow, { props: { title: 'T', checked: false } })
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('update:checked')).toEqual([[true]])

    const on = mount(ToggleRow, { props: { title: 'T', checked: true } })
    await on.get('[role="switch"]').trigger('click')
    expect(on.emitted('update:checked')).toEqual([[false]])
  })

  it('ignores clicks while disabled and omits empty description', () => {
    const wrapper = mount(ToggleRow, { props: { title: 'T', checked: true, disabled: true } })
    expect(wrapper.find('.toggle-label-desc').exists()).toBe(false)
    wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('update:checked')).toBeUndefined()
  })
})
