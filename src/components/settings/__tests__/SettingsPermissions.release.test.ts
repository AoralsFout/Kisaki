import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('../../../agent/toolPolicy', () => ({
  getAutoExecFiles: () => false,
  setAutoExecFiles: vi.fn(),
  getCommandEnabled: () => false,
  setCommandEnabled: vi.fn(),
}))
vi.mock('../../../constants', () => ({
  EXPERIMENTAL_COMMAND_AVAILABLE: false,
}))

describe('SettingsPermissions release mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hosts the file auto-run switch and hides the experimental command switch', async () => {
    const { default: SettingsPermissions } = await import('../SettingsPermissions.vue')
    const wrapper = mount(SettingsPermissions)

    expect(wrapper.text()).toContain('settings.permissions.autoExecTitle')
    expect(wrapper.text()).not.toContain('settings.permissions.commandTitle')
  })
})
