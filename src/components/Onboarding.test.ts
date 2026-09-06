import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Onboarding from './Onboarding.vue'

// API 配置检测：isConfigValid 由用例控制（true = 已保存有效配置）
const aiState = vi.hoisted(() => ({ valid: false }))
vi.mock('../ai', () => ({
  loadConfigSecure: vi.fn(async () => ({ baseURL: 'https://api.x/v1', apiKey: 'sk-1', model: 'm1' })),
  isConfigValid: () => aiState.valid,
}))
// 角色列表：getter 返回用例注入的数组（组件只读 availableList）
const charState = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('../stores/character', () => ({
  useCharacterStore: () => ({ get availableList() { return charState.list } }),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

function mountOnboarding() {
  return mount(Onboarding, { props: { visible: true } })
}

beforeEach(() => {
  aiState.valid = false
  charState.list = []
})

describe('Onboarding', () => {
  it('offers 继续配置 to the first pending step and never marks done while incomplete', async () => {
    const wrapper = mountOnboarding()
    await flushPromises()

    // 主按钮 = 继续配置，指向第一个未完成步骤（API）
    expect(wrapper.text()).toContain('onboarding.continue')
    expect(wrapper.text()).not.toContain('onboarding.start')
    await wrapper.get('.ob-primary').trigger('click')
    expect(wrapper.emitted('open-settings')).toEqual([['api']])
    expect(wrapper.emitted('finish')).toBeUndefined()

    // 稍后只搁置，不产生完成标记
    await wrapper.get('.ob-later').trigger('click')
    expect(wrapper.emitted('later')).toHaveLength(1)
    expect(wrapper.emitted('finish')).toBeUndefined()

    // 两个步骤按钮分别定位对应标签
    const stepBtns = wrapper.findAll('.ob-step-btn')
    await stepBtns[0].trigger('click')
    await stepBtns[1].trigger('click')
    expect(wrapper.emitted('open-settings')).toEqual([['api'], ['api'], ['character']])
  })

  it('routes 继续配置 to the character tab once the API config is saved', async () => {
    aiState.valid = true
    const wrapper = mountOnboarding()
    await flushPromises()

    await wrapper.get('.ob-primary').trigger('click')
    expect(wrapper.emitted('open-settings')).toEqual([['character']])
  })

  it('switches the primary button to 开始使用 and finishes only when both steps are ready', async () => {
    aiState.valid = true
    charState.list = ['kisaki']
    const wrapper = mountOnboarding()
    await flushPromises()

    expect(wrapper.text()).toContain('onboarding.start')
    expect(wrapper.text()).not.toContain('onboarding.continue')
    expect(wrapper.find('.ob-later').exists()).toBe(false)
    await wrapper.get('.ob-primary').trigger('click')
    expect(wrapper.emitted('finish')).toHaveLength(1)
    expect(wrapper.emitted('later')).toBeUndefined()
  })
})
