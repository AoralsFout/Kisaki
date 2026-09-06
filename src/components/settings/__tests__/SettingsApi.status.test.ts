import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsApi from '../SettingsApi.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => {}) }))

const ai = vi.hoisted(() => ({ save: vi.fn(), test: vi.fn() }))
vi.mock('../../../ai', () => ({
  DEFAULT_CONFIG: { baseURL: '', apiKey: '', model: '' },
  loadConfigSecure: vi.fn(async () => ({ baseURL: 'https://api.x/v1', apiKey: 'sk-1', model: 'm1' })),
  saveConfigSecure: (value: unknown) => ai.save(value),
  isConfigValid: () => true,
  testAIConnection: () => ai.test(),
}))

beforeEach(() => {
  ai.save.mockResolvedValue(undefined)
  ai.test.mockResolvedValue({ ok: true })
})

describe('SettingsApi saved/connection status', () => {
  it('does not claim a working connection from valid fields; shows saved state after saving', async () => {
    const wrapper = mount(SettingsApi)
    await flushPromises()

    // 字段已填写且有效：不得出现任何「连接可用/成功」样式文案
    expect(wrapper.text()).not.toContain('settings.api.configOk')
    expect(wrapper.text()).not.toContain('settings.api.testOk')
    expect(wrapper.find('.status-ok').exists()).toBe(false)

    await wrapper.get('.btn-save').trigger('click')
    await flushPromises()
    expect(ai.save).toHaveBeenCalledOnce()
    // 已保存 ≠ 连接成功
    expect(wrapper.get('.status-ok').text()).toBe('settings.api.savedOk')
  })

  it('clears the stale connection test result once the config changes', async () => {
    const wrapper = mount(SettingsApi)
    await flushPromises()

    await wrapper.get('.btn-secondary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('settings.api.testOk')

    await wrapper.get('.form-input').setValue('https://api.y/v1')
    await flushPromises()
    expect(wrapper.text()).not.toContain('settings.api.testOk')
    // 编辑中回到未保存态
    expect(wrapper.find('.status-ok').exists()).toBe(false)
  })
})
