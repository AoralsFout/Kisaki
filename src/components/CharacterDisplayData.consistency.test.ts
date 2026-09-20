import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CharacterList from './CharacterList.vue'
import CharacterSelect from './CharacterSelect.vue'

const displayList = [
  { id: 'alice', name: '爱丽丝', render: 'illustration' as const },
  { id: 'mio', name: 'Mio', render: 'live2d' as const },
]

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (
  params ? `${key}:${String(params.name ?? params.n)}` : key
) }) }))
vi.mock('../stores/character', () => ({
  useCharacterStore: () => ({
    currentId: 'alice',
    characterDisplayList: displayList,
  }),
}))
vi.mock('../utils/modalFocus', () => ({
  useModalFocus: () => undefined,
}))

describe('角色列表显示数据一致性', () => {
  it('编辑器卡片和底部选择器使用相同的名称投影', () => {
    const list = mount(CharacterList, {
      props: { characters: displayList, currentId: 'alice' },
    })
    const select = mount(CharacterSelect, { props: { visible: true } })

    expect(list.findAll('.card-name').map(node => node.text())).toEqual(['爱丽丝', 'Mio', 'character.list.add'])
    expect(select.findAll('.char-name').map(node => node.text())).toEqual([
      'character.select.current:爱丽丝',
      'Mio',
    ])
  })
})
