import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCharacterJson } from '../characterJson'
import { initCharacterDataDir, loadCharacterJson } from '../loader'
import type { CharacterData } from '../loader'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (path: string) => path,
}))

const baseCharacter: CharacterData = {
  id: 'hiyori',
  name: 'Hiyori',
  description: 'Live2D 角色',
  version: 2,
  prompt: '旧人设不会写入 character.json',
  poses: ['standing'],
  emotions: ['idle'],
  costumes: ['default'],
  images: [],
  voice: 'voice-id',
  voiceModel: 'model-id',
  voiceLanguage: 'ja-JP',
  textLanguage: 'zh-CN',
  render: 'live2d',
  live2d: {
    model: 'live2d/Hiyori/Hiyori.model3.json',
    scale: 1.25,
    offsetX: 4,
    offsetY: -2,
    idleMotionGroup: 'Idle',
    tapMotionGroup: 'TapBody',
    mouseFollow: true,
    expressions: { happy: '开心' },
    motions: { Idle: '待机' },
  },
}

describe('角色编辑保存格式护栏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockImplementation(async (command: string, args?: { filename?: string; content?: string }) => {
      if (command === 'get_data_dirs') return { characters: 'test-characters' }
      if (command === 'read_character_file' && args?.filename === 'character.json') return args.content
      if (command === 'read_character_file' && args?.filename === 'prompt.txt') return '已保存人设'
      return undefined
    })
  })

  it('保存后的 Live2D 角色文件仍能被既有加载器读取并保留配置结构', async () => {
    const saved = buildCharacterJson(baseCharacter, 'live2d', {
      name: baseCharacter.name,
      description: baseCharacter.description,
      voice: baseCharacter.voice,
      voiceModel: baseCharacter.voiceModel,
      voiceLanguage: baseCharacter.voiceLanguage ?? 'ja-JP',
      textLanguage: baseCharacter.textLanguage ?? 'zh-CN',
      live2d: baseCharacter.live2d,
    })
    const savedText = JSON.stringify(saved)
    const files = new Map<string, string>([['prompt.txt', '已保存人设']])
    invoke.mockImplementation(async (command: string, args?: { filename?: string; content?: string }) => {
      if (command === 'get_data_dirs') return { characters: 'test-characters' }
      if (command === 'write_character_file' && args?.filename && args.content !== undefined) {
        files.set(args.filename, args.content)
        return undefined
      }
      if (command === 'read_character_file' && args?.filename) return files.get(args.filename)
      return undefined
    })

    await initCharacterDataDir()
    await invoke('write_character_file', { id: 'hiyori', filename: 'character.json', content: savedText })
    const loaded = await loadCharacterJson('hiyori')

    expect(loaded).toMatchObject({
      id: 'hiyori',
      render: 'live2d',
      prompt: '已保存人设',
      live2d: baseCharacter.live2d,
    })
    expect(JSON.parse(savedText)).not.toHaveProperty('prompt')
    expect(JSON.parse(savedText).live2d).toEqual(baseCharacter.live2d)
  })

  it('保存后的静态立绘角色文件保留既有角色字段并可读取', async () => {
    const illustration: CharacterData = {
      ...baseCharacter,
      id: 'kisaki',
      name: 'Kisaki',
      render: 'illustration',
      live2d: undefined,
      poses: ['standing', 'wave'],
      emotions: ['idle', 'happy'],
      costumes: ['default'],
      images: [{ file: 'kisaki.png', pose: 'standing', costume: 'default', emotions: ['idle'] }],
    }
    const saved = buildCharacterJson(illustration, 'illustration', {
      name: illustration.name,
      description: illustration.description,
      voiceLanguage: 'ja-JP',
      textLanguage: 'zh-CN',
      poses: illustration.poses,
      emotions: illustration.emotions,
      costumes: illustration.costumes,
      images: illustration.images,
    })
    const savedText = JSON.stringify(saved)
    invoke.mockImplementation(async (command: string, args?: { filename?: string }) => {
      if (command === 'read_character_file' && args?.filename === 'character.json') return savedText
      if (command === 'read_character_file' && args?.filename === 'prompt.txt') return '静态角色人设'
      return undefined
    })

    const loaded = await loadCharacterJson('kisaki')

    expect(loaded.render).toBe('illustration')
    expect(loaded.images).toEqual(illustration.images)
    expect(loaded.poses).toEqual(illustration.poses)
    expect(loaded.emotions).toEqual(illustration.emotions)
    expect(loaded.costumes).toEqual(illustration.costumes)
  })
})
