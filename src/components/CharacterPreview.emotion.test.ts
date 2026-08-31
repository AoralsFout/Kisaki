import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CharacterPreview from './CharacterPreview.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const image = {
  file: 'sample.png',
  pose: 'standing',
  costume: 'default',
  emotions: [],
}

describe('CharacterPreview 情绪标签输入', () => {
  it.each([' ', 'Enter'])('按下 %s 时创建标签并清空输入框', async (key) => {
    const wrapper = mount(CharacterPreview, {
      props: {
        image,
        imageUrl: 'sample.png',
        poses: ['standing'],
        costumes: ['default'],
      },
    })
    const input = wrapper.get<HTMLInputElement>('.emotion-input')

    await input.setValue('开心')
    await input.trigger('keydown', { key })

    expect(wrapper.emitted('add-emotion')).toEqual([['sample.png', '开心']])
    expect(input.element.value).toBe('')
  })

  it('输入法组字期间按回车不会创建标签', async () => {
    const wrapper = mount(CharacterPreview, {
      props: {
        image,
        imageUrl: 'sample.png',
        poses: ['standing'],
        costumes: ['default'],
      },
    })
    const input = wrapper.get<HTMLInputElement>('.emotion-input')

    await input.setValue('kai')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })

    expect(wrapper.emitted('add-emotion')).toBeUndefined()
    expect(input.element.value).toBe('kai')
  })
})
