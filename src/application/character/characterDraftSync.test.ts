import { describe, expect, it, vi } from 'vitest'
import type { CharacterSaveRequest, CharacterSaveResult } from './characterSaveWorkflow'
import { createCharacterDraftSync } from './characterDraftSync'
import type { CharacterData } from '../../character/loader'

function character(overrides: Partial<CharacterData> = {}): CharacterData {
  return {
    id: 'kisaki',
    name: 'Kisaki',
    description: '初始描述',
    version: 2,
    prompt: '初始人设',
    poses: ['standing'],
    emotions: ['idle'],
    costumes: ['default'],
    images: [{ file: 'standing.png', pose: 'standing', costume: 'default', emotions: [] }],
    voice: 'voice-1',
    voiceModel: 'model-1',
    voiceLanguage: 'ja-JP',
    textLanguage: 'zh-CN',
    render: 'illustration',
    customField: { keep: true },
    ...overrides,
  } as CharacterData
}

function savedResult(request: CharacterSaveRequest): CharacterSaveResult {
  return {
    status: 'saved', success: true, ok: true, diagnostics: [],
    completedSteps: ['prompt', 'definition', 'orphan-images', 'cache', 'broadcast'],
    definition: JSON.stringify({ ...request.data, name: request.edits.name, prompt: undefined }),
    orphanedFiles: [],
  }
}

function setup(save = vi.fn(async (request: CharacterSaveRequest) => savedResult(request))) {
  const sync = createCharacterDraftSync({ save })
  sync.load(character())
  return { sync, save }
}

describe('角色草稿同步层', () => {
  it('载入后提供统一投影，编辑命令只改变草稿并标记 dirty', () => {
    const { sync } = setup()
    expect(sync.projection).toMatchObject({ id: 'kisaki', name: 'Kisaki', prompt: '初始人设', voice: 'voice-1' })
    expect(sync.dirty).toBe(false)

    expect(sync.setPrompt('新提示词')).toBe(true)
    expect(sync.setName('新名字')).toBe(true)
    expect(sync.setVoice('voiceModel', 'model-2')).toBe(true)
    expect(sync.applyAppearance({ type: 'add-pose', value: 'sitting' })).toBe(true)
    expect(sync.projection?.prompt).toBe('新提示词')
    expect(sync.projection?.poses).toEqual(['standing', 'sitting'])
    expect(sync.dirty).toBe(true)
  })

  it('投影是只读快照，reset 恢复最近一次成功基线', () => {
    const { sync } = setup()
    const projection = sync.projection!
    expect(() => { (projection.poses as string[]).push('mutated') }).toThrow()
    sync.setDescription('临时描述')
    expect(sync.reset()).toBe(true)
    expect(sync.projection?.description).toBe('初始描述')
    expect(sync.dirty).toBe(false)
  })

  it('保存成功后以提交快照推进基线并保留未知字段', async () => {
    const { sync, save } = setup()
    sync.setPrompt('已保存人设')
    sync.setDescription('已保存描述')

    await expect(sync.save()).resolves.toBe(true)
    expect(save).toHaveBeenCalledOnce()
    const request = save.mock.calls[0][0]
    expect(request.prompt).toBe('已保存人设')
    expect((request.data as unknown as { customField: unknown }).customField).toEqual({ keep: true })
    expect(sync.dirty).toBe(false)
    expect(sync.error).toBeNull()

    sync.setPrompt('再次修改')
    await sync.save()
    expect((save.mock.calls[1][0].data as unknown as { customField: unknown }).customField).toEqual({ keep: true })
  })

  it('保存失败返回结构化错误，草稿和 dirty 保持不变', async () => {
    const failure: CharacterSaveResult = {
      status: 'failed', success: false, ok: false,
      diagnostics: [{ step: 'definition', reason: '磁盘已满', ignorable: false }],
      completedSteps: ['prompt'], definition: null, orphanedFiles: [],
    }
    const { sync } = setup(vi.fn(async () => failure))
    sync.setPrompt('待重试人设')

    await expect(sync.save()).resolves.toBe(false)
    expect(sync.projection?.prompt).toBe('待重试人设')
    expect(sync.dirty).toBe(true)
    expect(sync.error).toMatchObject({ type: 'save-failed', message: '磁盘已满', diagnostics: failure.diagnostics })
  })

  it('保存期间的新编辑不会被成功结果错误地标记为已保存', async () => {
    let resolveSave!: (result: CharacterSaveResult) => void
    const save = vi.fn((_request: CharacterSaveRequest) => new Promise<CharacterSaveResult>(resolve => { resolveSave = resolve }))
    const { sync } = setup(save)
    sync.setPrompt('第一次快照')
    const pending = sync.save()
    expect(sync.saving).toBe(true)
    sync.setPrompt('保存期间的新编辑')
    resolveSave(savedResult({ characterId: 'kisaki', data: character(), render: 'illustration', edits: { voiceLanguage: 'ja-JP', textLanguage: 'zh-CN' }, prompt: '第一次快照' }))

    await expect(pending).resolves.toBe(true)
    expect(sync.projection?.prompt).toBe('保存期间的新编辑')
    expect(sync.dirty).toBe(true)
    expect(sync.saving).toBe(false)
  })

  it('保存期间不可重复提交', async () => {
    let resolveSave!: (result: CharacterSaveResult) => void
    const save = vi.fn((_request: CharacterSaveRequest) => new Promise<CharacterSaveResult>(resolve => { resolveSave = resolve }))
    const { sync } = setup(save)
    sync.setPrompt('待保存')
    const first = sync.save()
    await expect(sync.save()).resolves.toBe(false)
    expect(save).toHaveBeenCalledOnce()
    resolveSave(savedResult({ characterId: 'kisaki', data: character(), render: 'illustration', edits: { voiceLanguage: 'ja-JP', textLanguage: 'zh-CN' }, prompt: '待保存' }))
    await first
  })
})
