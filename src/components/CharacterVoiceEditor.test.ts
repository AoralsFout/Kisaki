import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CharacterVoiceEditor from './CharacterVoiceEditor.vue'
import type { CharacterVoiceDraft, CharacterVoiceEditorPorts, CharacterVoicePreviewRequest } from '../application/character/characterVoiceEditor'
import type { VoiceInfo } from '../tts/types'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const draft = (): CharacterVoiceDraft => ({
  voice: 'voice-1',
  voiceModel: 'cosyvoice-v3-flash',
  voiceLanguage: 'ja-JP',
  textLanguage: 'zh-CN',
  gptsovitsRefAudio: 'ref.wav',
  gptsovitsPromptText: 'こんにちは',
  gptsovitsPromptLang: 'ja-JP',
})

const voices: VoiceInfo[] = [{
  voiceId: 'voice-1',
  gmtCreate: 'today',
  gmtModified: 'today',
  status: 'OK',
}]

function ports(overrides: Partial<CharacterVoiceEditorPorts> = {}): CharacterVoiceEditorPorts {
  return {
    loadVoices: vi.fn().mockResolvedValue(voices),
    preview: vi.fn().mockResolvedValue({ status: 'played' }),
    cancelPreview: vi.fn(),
    ...overrides,
  }
}

describe('CharacterVoiceEditor', () => {
  it('通过 change 意图编辑 CosyVoice 字段，并在 provider 切换时刷新能力', async () => {
    const editorPorts = ports()
    const wrapper = mount(CharacterVoiceEditor, {
      props: { draft: draft(), provider: 'cosyvoice', ports: editorPorts },
    })

    await vi.waitFor(() => expect(editorPorts.loadVoices).toHaveBeenCalledOnce())
    await wrapper.findAll<HTMLSelectElement>('.voice-editor-select')[1].setValue('voice-1')
    expect(wrapper.emitted('change')).toContainEqual(['voice', 'voice-1'])

    const selects = wrapper.findAll<HTMLSelectElement>('.voice-editor-select')
    await selects[2].setValue('en-US')
    expect(wrapper.emitted('change')).toContainEqual(['voiceLanguage', 'en-US'])

    await wrapper.setProps({ provider: 'gptsovits' })
    await wrapper.setProps({ provider: 'cosyvoice' })
    await vi.waitFor(() => expect(editorPorts.loadVoices).toHaveBeenCalledTimes(2))
  })

  it('GPT-SoVITS 参考音频通过端口选择并输出编辑意图', async () => {
    const pickReferenceAudio = vi.fn().mockResolvedValue('picked.wav')
    const wrapper = mount(CharacterVoiceEditor, {
      props: { draft: draft(), provider: 'gptsovits', ports: ports({ pickReferenceAudio }) },
    })

    await wrapper.get('.voice-editor-icon-button').trigger('click')
    await vi.waitFor(() => expect(pickReferenceAudio).toHaveBeenCalledOnce())
    expect(wrapper.emitted('change')).toContainEqual(['gptsovitsRefAudio', 'picked.wav'])

    await wrapper.findAll('.voice-editor-input')[1].setValue('new transcript')
    expect(wrapper.emitted('change')).toContainEqual(['gptsovitsPromptText', 'new transcript'])
  })

  it('试听读取当前投影，开始和完成不会修改草稿', async () => {
    let resolvePreview!: (result: { status: 'played' }) => void
    const preview = vi.fn().mockImplementation((_request: CharacterVoicePreviewRequest) => new Promise(resolve => { resolvePreview = resolve }))
    const editorPorts = ports({ preview })
    const currentDraft = draft()
    const wrapper = mount(CharacterVoiceEditor, {
      props: { draft: currentDraft, provider: 'cosyvoice', characterId: 'alice', ports: editorPorts },
    })

    await vi.waitFor(() => expect(editorPorts.loadVoices).toHaveBeenCalled())
    await wrapper.get('.voice-editor-preview-button').trigger('click')
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'voice-preview:alice',
      voiceId: 'voice-1',
      voiceModel: 'cosyvoice-v3-flash',
    }))
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(currentDraft.voice).toBe('voice-1')

    await wrapper.get('.voice-editor-preview-button').trigger('click')
    expect(editorPorts.cancelPreview).toHaveBeenCalledWith('preview-cancelled', true)
    resolvePreview({ status: 'played' })
    await vi.waitFor(() => expect(wrapper.get('.voice-editor-preview-button').text()).toContain('character.mgr.preview'))
  })

  it('试听失败仅显示诊断，不影响草稿编辑', async () => {
    const preview = vi.fn().mockRejectedValue(new Error('服务不可用'))
    const editorPorts = ports({ preview })
    const wrapper = mount(CharacterVoiceEditor, {
      props: { draft: draft(), provider: 'cosyvoice', ports: editorPorts },
    })

    await vi.waitFor(() => expect(editorPorts.loadVoices).toHaveBeenCalled())
    await wrapper.get('.voice-editor-preview-button').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('服务不可用'))
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('音色列表加载失败仍保留编辑能力并显示可诊断错误', async () => {
    const editorPorts = ports({ loadVoices: vi.fn().mockRejectedValue(new Error('API key missing')) })
    const wrapper = mount(CharacterVoiceEditor, {
      props: { draft: draft(), provider: 'cosyvoice', ports: editorPorts },
    })

    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('API key missing'))
    await wrapper.findAll('.voice-editor-input')[0].setValue('new-model')
    expect(wrapper.emitted('change')).toContainEqual(['voiceModel', 'new-model'])
  })
})
