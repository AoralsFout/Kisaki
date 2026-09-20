import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(null) }))
vi.mock('../tts', () => ({ getTtsProvider: () => 'none' }))
vi.mock('../application/settings/settingsChangeStream', () => ({ subscribeSettingsChange: vi.fn(() => () => undefined) }))
vi.mock('../character/loader', () => ({ bustImageCache: vi.fn(), initCharacterDataDir: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../character/live2d/manifest', () => ({ loadLive2DManifest: vi.fn().mockResolvedValue(null) }))

const store = reactive({
  currentId: 'alice',
  data: null as any,
  availableList: ['alice'],
  characterDisplayList: [{ id: 'alice', name: 'Alice', render: 'illustration' }],
  refreshList: vi.fn().mockResolvedValue(undefined),
  loadCharacter: vi.fn(async () => {
    store.data = {
      id: 'alice', name: 'Alice', description: '', version: 2, prompt: 'hello',
      render: 'illustration', poses: ['standing'], emotions: ['idle'], costumes: ['default'], images: [],
      voice: '', voiceModel: '', voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
    }
  }),
  getImageUrl: (file: string) => file,
})
vi.mock('../stores/character', () => ({ useCharacterStore: () => store }))

vi.mock('./CharacterList.vue', () => ({ default: defineComponent({ emits: ['select', 'create'], template: '<button class="choose" @click="$emit(\'select\', \'alice\')">choose</button>' }) }))
vi.mock('./CharacterCreateForm.vue', () => ({ default: defineComponent({ emits: ['created', 'close'], template: '<div data-testid="create-form" />' }) }))
vi.mock('./CharacterAppearanceEditor.vue', () => ({ default: defineComponent({ emits: ['edit'], template: '<button class="appearance" @click="$emit(\'edit\', { type: \'add-pose\', value: \'happy\' })">appearance</button>' }) }))
vi.mock('./CharacterVoiceEditor.vue', () => ({ default: defineComponent({ template: '<div data-testid="voice-editor" />' }) }))
vi.mock('./Live2DPreview.vue', () => ({ default: defineComponent({ template: '<div data-testid="live2d-preview" />' }) }))
vi.mock('./UnsavedDialog.vue', () => ({ default: defineComponent({ setup(_, { expose }) { expose({ ask: vi.fn().mockResolvedValue(false) }); return {} }, template: '<div />' }) }))
vi.mock('./ConfirmDialog.vue', () => ({ default: defineComponent({ template: '<div />' }) }))

import CharacterManager from './CharacterManager.vue'

describe('CharacterManager 装配', () => {
  beforeEach(() => { store.data = null; vi.clearAllMocks() })
  afterEach(() => { document.body.innerHTML = '' })

  it('按页面事件装配创建/外观/音色模块，并转发外观编辑意图', async () => {
    const wrapper = mount(CharacterManager)
    await wrapper.get('.choose').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="voice-editor"]').exists()).toBe(true)
    expect(wrapper.find('.appearance').exists()).toBe(true)
    await wrapper.get('.appearance').trigger('click')
    expect(wrapper.get('.btn-save-top').classes()).toContain('dirty')
    wrapper.unmount()
  })

  it('保存成功展示结果，并通过 EditablePage 形状暴露保存能力', async () => {
    const wrapper = mount(CharacterManager)
    await wrapper.get('.choose').trigger('click')
    await flushPromises()
    await wrapper.get('.editor-name-input').setValue('Alice 2')
    await wrapper.get('.btn-save-top').trigger('click')
    await flushPromises()
    expect(wrapper.find('.save-msg').text()).toContain('character.msg.saveSuccess')
    expect((wrapper.vm as { dirty: boolean }).dirty).toBe(false)
    wrapper.unmount()
  })

  it('未保存离开交给 UnsavedDialog，拒绝时保持编辑视图', async () => {
    const wrapper = mount(CharacterManager)
    await wrapper.get('.choose').trigger('click')
    await flushPromises()
    await wrapper.get('.editor-name-input').setValue('changed')
    await wrapper.get('.btn-back').trigger('click')
    await flushPromises()
    expect(wrapper.find('.editor-view').exists()).toBe(true)
    wrapper.unmount()
  })
})
