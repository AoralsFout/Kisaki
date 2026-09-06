import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPanel from './SettingsPanel.vue'
vi.mock('./CharacterManager.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsApi.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsSearch.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsTts.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsGeneral.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsPrivacy.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsAbout.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsPermissions.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/SettingsDiagnostics.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./settings/DevPanel.vue', () => ({ default: { template: '<div />' } }))

// 捕获设置窗口导航监听器：主窗口 emitTo(EVENT_SETTINGS_NAVIGATE) 的接收端
const navigate = vi.hoisted(() => ({ cb: null as null | ((e: { payload: { tab?: string } }) => void) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: { tab?: string } }) => void) => {
    navigate.cb = cb
    return () => { navigate.cb = null }
  }),
}))

const native = vi.hoisted(() => ({ callback: null as null | ((e: { preventDefault: () => void }) => Promise<void>), close: vi.fn(), remove: vi.fn() }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({
  onCloseRequested: vi.fn(async cb => { native.callback = cb; return native.remove }),
  close: native.close,
}) }))
vi.mock('../utils/windowState', () => ({ initWindowState: vi.fn().mockResolvedValue(undefined) }))
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key }) }))

const save = vi.fn()
const Page = defineComponent({
  setup(_, { expose }) {
    const text = ref('original')
    const dirty = computed(() => text.value !== 'original')
    expose({ dirty, saving: false, save: async () => { if (!await save()) return false; text.value = 'original'; return true } })
    return { text }
  },
  template: '<input class="test-edit" v-model="text" />',
})
function options() {
  return { global: { stubs: { SettingsApi: Page, SettingsSearch: Page, SettingsTts: Page, CharacterManager: Page, SettingsGeneral: true, SettingsPrivacy: true, SettingsAbout: true, SettingsPermissions: true, SettingsDiagnostics: true, DevPanel: true } } }
}
function action(label: string) {
  [...document.querySelectorAll<HTMLButtonElement>('.safety-actions button')].find(b => b.textContent === label)!.click()
}
function activeTabLabel(wrapper: ReturnType<typeof mount>) {
  const el = wrapper.findAll('.nav-item').find(b => b.classes().includes('active'))
  return el?.text().trim() ?? ''
}
beforeEach(() => { window.history.replaceState({}, '', '/?settings=1&tab=api'); save.mockResolvedValue(true) })
afterEach(() => { document.body.innerHTML = ''; window.history.replaceState({}, '', '/'); vi.clearAllMocks() })

describe('settings leave paths', () => {
  it('guards tab changes and stays after failed save; discard changes tabs', async () => {
    const wrapper = mount(SettingsPanel, options())
    await flushPromises()
    await wrapper.get('.test-edit').setValue('changed')
    const general = wrapper.findAll('.nav-item')[0]
    await general.trigger('click')
    await flushPromises()
    action('safety.keepEditing')
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('.test-edit').element.value).toBe('changed')
    save.mockResolvedValueOnce(false)
    await general.trigger('click')
    await flushPromises()
    action('safety.saveLeave')
    await flushPromises()
    expect(wrapper.find('.test-edit').exists()).toBe(true)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('safety.leaveFailed')
    action('safety.discard')
    await flushPromises()
    expect(wrapper.find('.test-edit').exists()).toBe(false)
    wrapper.unmount()
  })

  it('intercepts native close, cancels safely, then saves before closing', async () => {
    const wrapper = mount(SettingsPanel, options())
    await flushPromises()
    await wrapper.get('.test-edit').setValue('changed')
    const preventDefault = vi.fn()
    const first = native.callback!({ preventDefault })
    await flushPromises()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(native.close).not.toHaveBeenCalled()
    action('safety.keepEditing')
    await first
    expect(native.close).not.toHaveBeenCalled()
    const second = native.callback!({ preventDefault })
    await flushPromises()
    action('safety.saveLeave')
    await second
    expect(save).toHaveBeenCalledOnce()
    expect(native.close).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(native.remove).toHaveBeenCalledOnce()
  })

  it('navigates to the requested tab from other windows, guarded by unsaved changes', async () => {
    const wrapper = mount(SettingsPanel, options())
    await flushPromises()
    expect(activeTabLabel(wrapper)).toBe('settings.nav.api')

    // 无未保存更改：直接切换到目标标签
    navigate.cb!({ payload: { tab: 'tts' } })
    await flushPromises()
    expect(activeTabLabel(wrapper)).toBe('settings.nav.tts')

    // 有未保存更改：先弹确认，放弃后才切换
    await wrapper.get('.test-edit').setValue('changed')
    navigate.cb!({ payload: { tab: 'search' } })
    await flushPromises()
    expect(activeTabLabel(wrapper)).toBe('settings.nav.tts')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('safety.unsavedBody')
    action('safety.discard')
    await flushPromises()
    expect(activeTabLabel(wrapper)).toBe('settings.nav.search')
    expect(wrapper.get<HTMLInputElement>('.test-edit').element.value).toBe('original')

    // 未知标签忽略；当前标签重复请求不弹确认
    navigate.cb!({ payload: { tab: 'not-a-tab' } })
    await flushPromises()
    expect(activeTabLabel(wrapper)).toBe('settings.nav.search')
    navigate.cb!({ payload: { tab: 'search' } })
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    wrapper.unmount()
  })
})
