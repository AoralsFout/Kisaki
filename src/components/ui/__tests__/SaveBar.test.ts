import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SaveBar from '../SaveBar.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('SaveBar', () => {
  it('shows save label by default, saved label when saved and clean', () => {
    const idle = mount(SaveBar)
    expect(idle.get('button').text()).toBe('common.save')

    const saved = mount(SaveBar, { props: { saved: true, dirty: false } })
    expect(saved.get('button').text()).toBe('common.saved')

    // 有新输入时回到可保存态
    const dirty = mount(SaveBar, { props: { saved: true, dirty: true } })
    expect(dirty.get('button').text()).toBe('common.save')
  })

  it('shows custom text, busy state and emits save', async () => {
    const wrapper = mount(SaveBar, { props: { saving: true, saveText: 'settings.tts.saveConfig' } })
    expect(wrapper.get('button').text()).toBe('safety.saving')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()

    const ready = mount(SaveBar, { props: { saveText: 'settings.tts.saveConfig' } })
    expect(ready.get('button').text()).toBe('settings.tts.saveConfig')
    await ready.get('button').trigger('click')
    expect(ready.emitted('save')).toHaveLength(1)
  })

  it('renders extra buttons, status slot and error line', async () => {
    const wrapper = mount(SaveBar, {
      props: { error: 'boom' },
      slots: { default: '<button class="extra">extra</button>', status: '<span class="badge">badge</span>' },
    })
    expect(wrapper.find('.extra').exists()).toBe(true)
    expect(wrapper.find('.badge').exists()).toBe(true)
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('safety.saveFailed')

    const clean = mount(SaveBar)
    expect(clean.find('[role="alert"]').exists()).toBe(false)
  })
})
