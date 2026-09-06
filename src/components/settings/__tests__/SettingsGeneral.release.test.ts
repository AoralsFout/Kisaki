import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const motionMocks = vi.hoisted(() => ({
  setReducedMotionEnabled: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isEnabled: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../../i18n', () => ({
  UI_LANGUAGES: [{ value: 'zh-CN', label: '简体中文' }],
  getUiLanguage: () => 'zh-CN',
  setUiLanguage: vi.fn(),
}))
vi.mock('../../../utils/motionPreference', () => ({
  isReducedMotionEnabled: () => false,
  setReducedMotionEnabled: motionMocks.setReducedMotionEnabled,
}))
vi.mock('../../../agent/toolPolicy', () => ({
  getAutoExecFiles: () => false,
  setAutoExecFiles: vi.fn(),
  getCommandEnabled: () => false,
  setCommandEnabled: vi.fn(),
}))
vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))
vi.mock('../../../constants', () => ({
  EXPERIMENTAL_COMMAND_AVAILABLE: false,
  STORAGE_CHARACTER_OPACITY: 'deskpet-character-opacity',
  STORAGE_CHARACTER_OPACITY_WHEEL_ENABLED: 'deskpet-character-opacity-wheel-enabled',
}))

describe('SettingsGeneral release mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps normal settings and moves the permission switches to the permissions page', async () => {
    const { default: SettingsGeneral } = await import('../SettingsGeneral.vue')
    const wrapper = mount(SettingsGeneral)

    expect(wrapper.text()).toContain('settings.general.uiLang')
    expect(wrapper.text()).toContain('settings.general.reducedMotionTitle')
    expect(wrapper.text()).not.toContain('settings.general.autoExecTitle')
    expect(wrapper.text()).not.toContain('settings.general.commandTitle')

    const switches = wrapper.findAll('[role="switch"]')
    await switches[1].trigger('click')
    expect(motionMocks.setReducedMotionEnabled).toHaveBeenCalledWith(true)
  })
})
