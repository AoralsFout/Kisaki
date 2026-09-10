import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCharacterStore } from '../character'
import { listCharacterSummaries, loadCharacterJson } from '../../character/loader'

vi.mock('../../character/loader', () => ({
  listCharacterSummaries: vi.fn(),
  loadCharacterJson: vi.fn(),
  imageUrl: vi.fn((id: string, file: string) => `${id}/${file}`),
  clearCache: vi.fn(),
}))

const character = (id: string) => ({
  id,
  name: id.toUpperCase(),
  description: '',
  version: 2,
  prompt: `${id} prompt`,
  render: 'illustration' as const,
  poses: ['default'],
  emotions: ['normal'],
  costumes: ['default'],
  images: [],
})

describe('useCharacterStore init', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(listCharacterSummaries).mockResolvedValue([
      { id: 'chryso', name: 'Chryso', render: 'illustration' },
      { id: 'kisaki', name: 'Kisaki', render: 'illustration' },
    ])
    vi.mocked(loadCharacterJson).mockImplementation(async id => character(id))
  })

  it('启动时直接加载会话指定的角色', async () => {
    const store = useCharacterStore()

    await store.init('chryso')

    expect(store.currentId).toBe('chryso')
    expect(vi.mocked(loadCharacterJson).mock.calls.map(([id]) => id)).toEqual(['chryso'])
  })

  it('会话角色不存在时回退到 kisaki', async () => {
    const store = useCharacterStore()

    await store.init('missing')

    expect(store.currentId).toBe('kisaki')
  })

  it('将视觉状态写入 Runtime 并从 Store 投影', async () => {
    const store = useCharacterStore()
    await store.init('chryso')

    store.applyVisualState({ emotion: 'normal', screenPose: 'full-left' })

    expect(store.getRuntimeSnapshot()).toMatchObject({
      characterId: 'chryso',
      look: { emotion: 'normal', stance: 'default', costume: 'default', screenPose: 'full-left' },
    })
    expect(store.currentScreenPose).toBe('full-left')
  })

  it('角色加载前收到的会话视觉状态在选择角色后应用', async () => {
    const store = useCharacterStore()
    store.applyVisualState({ screenPose: 'half-right' })

    await store.init('chryso')

    expect(store.currentScreenPose).toBe('half-right')
  })

  it('renderer 通过 Store 端口接收 Runtime 快照', async () => {
    const store = useCharacterStore()
    await store.init('chryso')
    const apply = vi.fn()
    store.attachRenderer('illustration', { apply })
    await Promise.resolve()

    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'chryso' }))
  })
})
