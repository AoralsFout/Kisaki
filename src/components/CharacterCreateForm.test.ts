import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CharacterCreateForm from './CharacterCreateForm.vue'
import type { CharacterCreationPorts } from '../application/character/characterCreation'

function ports(overrides: Partial<CharacterCreationPorts> = {}): CharacterCreationPorts {
  return {
    files: {
      writeDefinition: vi.fn().mockResolvedValue(undefined),
      writePrompt: vi.fn().mockResolvedValue(undefined),
    },
    refreshDisplayData: vi.fn().mockResolvedValue(undefined),
    broadcastCharactersChanged: vi.fn().mockResolvedValue(undefined),
    enterEditor: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('CharacterCreateForm', () => {
  it('表单自身持有输入，成功后才清空并发出进入编辑意图', async () => {
    const creationPorts = ports()
    const wrapper = mount(CharacterCreateForm, { props: { existingIds: [], ports: creationPorts } })
    await wrapper.get('[data-testid="character-create-id"]').setValue('alice')
    await wrapper.get('[data-testid="character-create-name"]').setValue('爱丽丝')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('created')).toEqual([['alice']]))

    expect((wrapper.get('[data-testid="character-create-id"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.emitted('close')).toEqual([[]])
    expect(creationPorts.files.writeDefinition).toHaveBeenCalledOnce()
  })

  it('Live2D 导入失败保留输入并展示后端原因', async () => {
    const creationPorts = ports({ importLive2DModel: vi.fn().mockRejectedValue(new Error('模型目录无效')) })
    const wrapper = mount(CharacterCreateForm, {
      props: {
        existingIds: [],
        ports: creationPorts,
        modelPicker: vi.fn().mockResolvedValue('picked-model'),
      },
    })
    await wrapper.find('input[value="live2d"]').setValue(true)
    await wrapper.get('button[type="button"]').trigger('click')
    await wrapper.get('[data-testid="character-create-id"]').setValue('alice')
    await wrapper.get('form').trigger('submit')

    await vi.waitFor(() => expect(wrapper.get('[data-testid="character-create-error"]').text()).toContain('模型目录无效'))
    expect((wrapper.get('[data-testid="character-create-id"]').element as HTMLInputElement).value).toBe('alice')
    expect(wrapper.emitted('created')).toBeUndefined()
  })

  it('忙碌时忽略重复提交', async () => {
    let release!: () => void
    const creationPorts = ports({
      files: {
        writeDefinition: vi.fn(() => new Promise<void>(resolve => { release = resolve })),
        writePrompt: vi.fn().mockResolvedValue(undefined),
      },
    })
    const wrapper = mount(CharacterCreateForm, { props: { existingIds: [], ports: creationPorts } })
    await wrapper.get('[data-testid="character-create-id"]').setValue('alice')
    const form = wrapper.get('form')
    void form.trigger('submit')
    await vi.waitFor(() => expect(creationPorts.files.writeDefinition).toHaveBeenCalledOnce())
    void form.trigger('submit')
    expect(creationPorts.files.writeDefinition).toHaveBeenCalledOnce()
    release()
  })
})
