import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsTts from '../SettingsTts.vue'
import UnsavedDialog from '../../UnsavedDialog.vue'

const tts = vi.hoisted(() => ({
  cosyVoiceSave: vi.fn(),
  gptSoVitsSave: vi.fn(),
  setProvider: vi.fn(),
}))

vi.mock('../../../tts', () => ({
  DEFAULT_COSYVOICE_CONFIG: { apiKey: '', model: 'cosyvoice-v3-flash', region: 'beijing' },
  DEFAULT_GPTSOVITS_CONFIG: {
    apiUrl: 'http://127.0.0.1:9880', topK: 15, topP: 1, temperature: 1, speedFactor: 1,
  },
  REGIONS: { beijing: { label: '北京' }, singapore: { label: '新加坡' } },
  MODELS: [{ label: 'CosyVoice v3 Flash', value: 'cosyvoice-v3-flash' }],
  loadCosyVoiceConfigSecure: vi.fn(async () => ({ apiKey: 'old-key', model: 'cosyvoice-v3-flash', region: 'beijing' })),
  saveCosyVoiceConfigSecure: (value: unknown) => tts.cosyVoiceSave(value),
  loadGptSoVitsConfig: vi.fn(() => ({
    apiUrl: 'http://127.0.0.1:9880', topK: 15, topP: 1, temperature: 1, speedFactor: 1,
  })),
  saveGptSoVitsConfig: (value: unknown) => tts.gptSoVitsSave(value),
  getTtsProvider: vi.fn(() => 'cosyvoice'),
  setTtsProvider: (value: unknown) => tts.setProvider(value),
  isTtsEnabled: vi.fn(() => false),
  setTtsEnabled: vi.fn(),
}))
vi.mock('../../../tts/api', () => ({ fetchVoiceList: vi.fn(async () => []) }))
vi.mock('../../../character', () => ({ useCharacterStore: () => ({ data: null }) }))
vi.mock('../../../stores/language', () => ({
  getDisplayLanguage: () => 'zh-CN',
  setDisplayLanguage: vi.fn(),
  SUPPORTED_LANGUAGES: [{ value: 'zh-CN', label: '简体中文' }],
}))
vi.mock('vue-i18n', async original => ({
  ...await original<typeof import('vue-i18n')>(),
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.message ? `${key}: ${values.message}` : key,
  }),
}))

function action(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.safety-actions button')]
    .find(item => item.textContent === label)
  if (!button) throw new Error(`未找到操作按钮：${label}`)
  button.click()
}

beforeEach(() => {
  tts.cosyVoiceSave.mockReset().mockResolvedValue(undefined)
  tts.gptSoVitsSave.mockReset().mockRejectedValueOnce(new Error('GPT-SoVITS 写入失败'))
  tts.setProvider.mockReset()
})

afterEach(() => { document.body.innerHTML = '' })

describe('TTS 两组表单部分保存', () => {
  it('失败组保留错误和离开守卫，重试时跳过已保存组', async () => {
    const page = mount(SettingsTts)
    const dialog = mount(UnsavedDialog)
    await flushPromises()

    await page.get('input[type="password"]').setValue('new-key')
    const gptSoVits = page.findAll('.provider-tab').find(item => item.text().includes('settings.tts.providerGptSoVits'))
    if (!gptSoVits) throw new Error('未找到 GPT-SoVITS 提供者按钮')
    await gptSoVits.trigger('click')
    await page.get('input[type="url"]').setValue('http://127.0.0.1:9881')

    const leave = dialog.vm.ask(page.vm)
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('safety.unsavedBody')
    action('safety.saveLeave')
    await flushPromises()

    expect(tts.cosyVoiceSave).toHaveBeenCalledOnce()
    expect(tts.cosyVoiceSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'new-key' }))
    expect(tts.gptSoVitsSave).toHaveBeenCalledOnce()
    expect(tts.gptSoVitsSave).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: 'http://127.0.0.1:9881' }))
    expect(page.vm.dirty).toBe(true)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('safety.leaveFailed')
    expect(page.get('[role="alert"]').text()).toContain('GPT-SoVITS 写入失败')

    let finishRetry!: () => void
    tts.gptSoVitsSave.mockImplementationOnce(() => new Promise<void>(resolve => { finishRetry = resolve }))
    action('safety.saveLeave')
    await flushPromises()

    expect(page.vm.saving).toBe(true)
    expect(page.vm.dirty).toBe(true)
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(tts.cosyVoiceSave).toHaveBeenCalledOnce()
    expect(tts.gptSoVitsSave).toHaveBeenCalledTimes(2)

    finishRetry()
    expect(await leave).toBe(true)
    await flushPromises()
    expect(page.vm.dirty).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    dialog.unmount()
    page.unmount()
  })
})
