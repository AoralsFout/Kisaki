import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadCharacterJsonMock } = vi.hoisted(() => ({ loadCharacterJsonMock: vi.fn() }))

// 角色 JSON 的磁盘读取属于角色加载器自己的测试面；这里只关心 store 里放的是什么。
vi.mock('../../character/loader', () => ({
  loadCharacterJson: loadCharacterJsonMock,
  clearCache: vi.fn(),
  listCharacterSummaries: vi.fn(async () => []),
  imageUrl: vi.fn(() => ''),
}))

import type { CharacterData } from '../../character/loader'
import { DEFAULT_VOICE_LANGUAGE, STORAGE_DISPLAY_LANGUAGE } from '../../constants'
import { useCharacterStore } from '../../stores/character'
import { CharacterStoreSource } from './characterStoreSource'

const character: CharacterData = {
  id: 'kisaki',
  name: 'Kisaki',
  description: '',
  version: 1,
  prompt: '',
  poses: ['normal'],
  emotions: ['neutral'],
  costumes: ['default'],
  images: [],
  voice: 'voice-x',
  voiceLanguage: 'ja-JP',
  textLanguage: 'en-US',
  render: 'live2d',
}

async function storeWithCharacter() {
  const store = useCharacterStore()
  await store.loadCharacter('kisaki', true)
  return store
}

describe('CharacterStoreSource', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    loadCharacterJsonMock.mockReset()
    loadCharacterJsonMock.mockResolvedValue(character)
    localStorage.removeItem(STORAGE_DISPLAY_LANGUAGE)
  })

  it('projects the loaded character into the round state', async () => {
    const store = await storeWithCharacter()

    const state = new CharacterStoreSource().state()

    expect(state.identity).toEqual({ id: 'kisaki', name: 'Kisaki' })
    expect(state.persona).toBe('Kisaki')
    expect(state.voice).toBe('voice-x')
    expect(state.voiceLanguage).toBe('ja-JP')
    expect(state.displayLanguage).toBe('en-US')
    expect(state.render).toBe('live2d')
    expect(state.data).toBe(store.data)
    expect(state.capabilities).toEqual(store.getRuntimeSnapshot().capabilities)
    expect(state.capabilities).not.toBeNull()
  })

  it('reads the character store afresh on every call', async () => {
    const source = new CharacterStoreSource()
    expect(source.state().identity).toBeNull()

    await storeWithCharacter()

    expect(source.state().identity).toEqual({ id: 'kisaki', name: 'Kisaki' })
  })

  it('keeps a usable shape when no character is loaded', () => {
    const state = new CharacterStoreSource().state()

    expect(state.identity).toBeNull()
    expect(state.data).toBeNull()
    expect(state.capabilities).toBeNull()
    expect(state.voice).toBe('')
    expect(state.voiceLanguage).toBe(DEFAULT_VOICE_LANGUAGE)
    expect(state.displayLanguage).toBe('zh-CN')
  })

  it('falls back to the default voice language when the character omits one', async () => {
    loadCharacterJsonMock.mockResolvedValue({ ...character, voiceLanguage: undefined, voice: undefined })

    await storeWithCharacter()

    const state = new CharacterStoreSource().state()
    expect(state.voiceLanguage).toBe(DEFAULT_VOICE_LANGUAGE)
    expect(state.voice).toBe('')
  })

  it('lets the user display-language preference win over the character default', async () => {
    localStorage.setItem(STORAGE_DISPLAY_LANGUAGE, 'fr-FR')

    await storeWithCharacter()

    expect(new CharacterStoreSource().state().displayLanguage).toBe('fr-FR')
  })

  it('defaults the render mode to illustration', async () => {
    loadCharacterJsonMock.mockResolvedValue({ ...character, render: undefined })

    await storeWithCharacter()

    expect(new CharacterStoreSource().state().render).toBe('illustration')
  })
})
