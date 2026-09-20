import { describe, expect, it, vi } from 'vitest'
import {
  buildCharacterPrompt,
  buildNewCharacterDefinition,
  createCharacter,
  validateCreateCharacter,
  type CharacterCreationInput,
  type CharacterCreationPorts,
} from './characterCreation'

const input = (overrides: Partial<CharacterCreationInput> = {}): CharacterCreationInput => ({
  id: 'alice',
  name: '爱丽丝',
  description: '桌宠',
  render: 'illustration',
  live2dModel: null,
  ...overrides,
})

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

describe('validateCreateCharacter', () => {
  it.each([
    [{ id: '' }, 'id', 'required'],
    [{ id: 'Alice' }, 'id', 'invalid-format'],
    [{ id: 'a-b' }, 'id', 'invalid-format'],
  ])('报告 ID 错误：%o', (changes, field, code) => {
    const result = validateCreateCharacter(input(changes), { existingIds: [] })
    expect(result.valid).toBe(false)
    expect(result.errors[field as 'id']).toBe(code)
  })

  it('拒绝重复 ID，但不把名称空值当作错误', () => {
    const result = validateCreateCharacter(input({ id: 'alice', name: '' }), { existingIds: ['alice'] })
    expect(result.errors.id).toBe('already-exists')
    expect(result.errors.name).toBeUndefined()
  })

  it('校验 Live2D 选择和 model3 文件完整性', () => {
    expect(validateCreateCharacter(input({ render: 'live2d' }), { existingIds: [] }).errors.live2dModel)
      .toBe('model-required')
    expect(validateCreateCharacter(input({ render: 'live2d', live2dModel: { directory: 'models', files: ['model.moc3'] } }), { existingIds: [] }).errors.live2dModel)
      .toBe('model-file-missing')
    expect(validateCreateCharacter(input({ render: 'live2d', live2dModel: { directory: 'models', files: ['model.model3.json'] } }), { existingIds: [] }).valid)
      .toBe(true)
  })
})

describe('build new character format', () => {
  it('保持立绘角色的既有默认字段和 prompt 格式', () => {
    const definition = buildNewCharacterDefinition(input())
    expect(definition).toMatchObject({
      id: 'alice', name: '爱丽丝', description: '桌宠', version: 2, render: 'illustration',
      poses: ['standing'], emotions: ['idle'], costumes: ['default'], images: [],
      voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
    })
    expect(buildCharacterPrompt('爱丽丝')).toBe('你是 爱丽丝，一个可爱的桌面宠物。')
  })

  it('保持 Live2D 配置形状并不写入静态立绘字段', () => {
    const definition = buildNewCharacterDefinition(input({ render: 'live2d' }), 'live2d/Model/Model.model3.json')
    expect(definition).toMatchObject({
      render: 'live2d',
      live2d: { model: 'live2d/Model/Model.model3.json', scale: 1, mouseFollow: true },
      poses: [], emotions: [], costumes: [], images: [],
    })
  })
})

describe('createCharacter', () => {
  it('校验失败时不产生任何文件或副作用', async () => {
    const creationPorts = ports()
    const result = await createCharacter(input({ id: 'Alice' }), { existingIds: [] }, creationPorts)
    expect(result.status).toBe('invalid')
    expect(creationPorts.files.writeDefinition).not.toHaveBeenCalled()
    expect(creationPorts.files.writePrompt).not.toHaveBeenCalled()
    expect(creationPorts.refreshDisplayData).not.toHaveBeenCalled()
  })

  it('Live2D 导入失败保留前置输入且不写入角色文件', async () => {
    const creationPorts = ports({ importLive2DModel: vi.fn().mockRejectedValue(new Error('未找到 model3')) })
    const result = await createCharacter(
      input({ render: 'live2d', live2dModel: { directory: 'picked-model' } }),
      { existingIds: [] },
      creationPorts,
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ stage: 'live2d-import', reason: '未找到 model3' })
    expect(creationPorts.files.writeDefinition).not.toHaveBeenCalled()
    expect(creationPorts.files.writePrompt).not.toHaveBeenCalled()
  })

  it('成功按导入→定义→prompt→刷新→广播→进入编辑顺序执行', async () => {
    const calls: string[] = []
    const creationPorts = ports({
      files: {
        writeDefinition: vi.fn(async () => { calls.push('definition') }),
        writePrompt: vi.fn(async () => { calls.push('prompt') }),
      },
      importLive2DModel: vi.fn(async () => { calls.push('import'); return 'live2d/M/M.model3.json' }),
      refreshDisplayData: vi.fn(async () => { calls.push('refresh') }),
      broadcastCharactersChanged: vi.fn(async () => { calls.push('broadcast') }),
      enterEditor: vi.fn(async () => { calls.push('navigate') }),
    })
    const result = await createCharacter(
      input({ render: 'live2d', live2dModel: { directory: 'picked-model' } }),
      { existingIds: [] },
      creationPorts,
    )
    expect(result.status).toBe('created')
    expect(calls).toEqual(['import', 'definition', 'prompt', 'refresh', 'broadcast', 'navigate'])
    expect(JSON.parse((creationPorts.files.writeDefinition as ReturnType<typeof vi.fn>).mock.calls[0][1])).toMatchObject({
      render: 'live2d', live2d: { model: 'live2d/M/M.model3.json' },
    })
  })

  it('写入失败时尽力清理已导入的角色目录并返回具体阶段', async () => {
    const deleteCharacter = vi.fn().mockResolvedValue(undefined)
    const creationPorts = ports({
      importLive2DModel: vi.fn().mockResolvedValue('live2d/M/M.model3.json'),
      files: {
        writeDefinition: vi.fn().mockRejectedValue(new Error('磁盘只读')),
        writePrompt: vi.fn(),
      },
      deleteCharacter,
    })
    const result = await createCharacter(
      input({ render: 'live2d', live2dModel: { directory: 'picked-model' } }),
      { existingIds: [] },
      creationPorts,
    )
    expect(result.error).toMatchObject({ stage: 'definition', reason: '磁盘只读' })
    expect(deleteCharacter).toHaveBeenCalledWith('alice')
    expect(creationPorts.files.writePrompt).not.toHaveBeenCalled()
  })
})
