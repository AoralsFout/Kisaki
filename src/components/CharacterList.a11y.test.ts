import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CharacterList from './CharacterList.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('CharacterList keyboard accessibility', () => {
  it('uses native buttons for character and create cards', async () => {
    const wrapper = mount(CharacterList, {
      props: { availableList: ['kisaki'], currentId: 'kisaki' },
    })
    const cards = wrapper.findAll('button.char-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].attributes('aria-current')).toBe('true')
    await cards[0].trigger('click')
    await cards[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['kisaki']])
    expect(wrapper.emitted('create')).toHaveLength(1)
  })
})
