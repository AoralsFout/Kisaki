import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

afterEach(() => { document.body.innerHTML = '' })

describe('ConfirmDialog keyboard accessibility', () => {
  it('focuses the safe action, traps focus, closes with Escape, and restores focus', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()

    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: {
        visible: false,
        title: 'Delete session',
        message: 'This cannot be undone',
        confirmLabel: 'Delete',
      },
    })

    await wrapper.setProps({ visible: true })
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(buttons[0])

    buttons[buttons.length - 1].focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    await wrapper.setProps({ visible: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)

    wrapper.unmount()
  })
})
