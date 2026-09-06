import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UnsavedDialog from './UnsavedDialog.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
afterEach(() => { document.body.innerHTML = '' })
function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === label)!
  button.click()
}

describe('unsaved changes decision', () => {
  it('cancel and discard never save, failed save keeps dialog open', async () => {
    const wrapper = mount(UnsavedDialog)
    const page = { dirty: true, saving: false, save: vi.fn().mockResolvedValue(false) }
    const first = wrapper.vm.ask(page)
    await flushPromises()
    click('safety.keepEditing')
    expect(await first).toBe(false)
    expect(page.save).not.toHaveBeenCalled()
    const second = wrapper.vm.ask(page)
    await flushPromises()
    click('safety.saveLeave')
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('safety.leaveFailed')
    click('safety.discard')
    expect(await second).toBe(true)
    expect(page.save).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('leaves only after save succeeds and no newer edits remain', async () => {
    const wrapper = mount(UnsavedDialog)
    const page = { dirty: true, saving: false, save: async () => { page.dirty = false; return true } }
    const answer = wrapper.vm.ask(page)
    await flushPromises()
    click('safety.saveLeave')
    expect(await answer).toBe(true)
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    wrapper.unmount()
  })
})
