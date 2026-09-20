import { describe, expect, it, vi } from 'vitest'
import type { CharacterData } from '../../character/loader'
import {
  saveCharacter,
  type CharacterSaveRequest,
  type CharacterSaveWorkflowPorts,
} from './characterSaveWorkflow'
import type { CharacterFilePort } from './characterFilePort'

const character: CharacterData = {
  id: 'kisaki',
  name: 'Kisaki',
  description: '角色描述',
  version: 2,
  prompt: '旧人设',
  poses: ['standing'],
  emotions: ['idle'],
  costumes: ['default'],
  images: [
    { file: 'keep.png', pose: 'standing', costume: 'default', emotions: ['idle'] },
    { file: 'orphan.png', pose: 'standing', costume: 'default', emotions: [] },
    { file: 'orphan.png', pose: 'standing', costume: 'default', emotions: [] },
  ],
  render: 'illustration',
  futureField: { keep: true },
} as CharacterData & { futureField: { keep: boolean } }

const edits = {
  name: '新 Kisaki',
  description: '新描述',
  voiceLanguage: 'ja-JP',
  textLanguage: 'zh-CN',
  poses: ['standing'],
  emotions: ['idle'],
  costumes: ['default'],
  images: [character.images[0]],
}

function makePorts(): {
  ports: CharacterSaveWorkflowPorts
  file: CharacterFilePort
  calls: string[]
} {
  const calls: string[] = []
  const file: CharacterFilePort = {
    writePrompt: vi.fn(async () => { calls.push('prompt') }),
    writeDefinition: vi.fn(async () => { calls.push('definition') }),
    saveImage: vi.fn(async () => { calls.push('save-image') }),
    deleteImage: vi.fn(async (_id, filename) => { calls.push(`delete:${filename}`) }),
  }
  return {
    file,
    calls,
    ports: {
      files: file,
      refreshCache: vi.fn(async () => { calls.push('cache') }),
      broadcastCharactersChanged: vi.fn(async () => { calls.push('broadcast') }),
    },
  }
}

function request(overrides: Partial<CharacterSaveRequest> = {}): CharacterSaveRequest {
  return {
    characterId: 'kisaki',
    data: character,
    render: 'illustration',
    edits,
    prompt: '新人设',
    ...overrides,
  }
}

describe('saveCharacter', () => {
  it('按固定顺序完成保存，并计算唯一的孤儿图集合', async () => {
    const { ports, calls, file } = makePorts()

    const result = await saveCharacter(request(), ports)

    expect(result).toMatchObject({ status: 'saved', success: true, ok: true })
    expect(result.completedSteps).toEqual(['prompt', 'definition', 'orphan-images', 'cache', 'broadcast'])
    expect(result.orphanedFiles).toEqual(['orphan.png'])
    expect(calls).toEqual(['prompt', 'definition', 'delete:orphan.png', 'cache', 'broadcast'])
    expect(file.deleteImage).toHaveBeenCalledOnce()
    expect(result.diagnostics).toEqual([])
  })

  it('写入定义时保留未知字段且不把 prompt 写入 character.json', async () => {
    const { ports, file } = makePorts()

    const result = await saveCharacter(request(), ports)
    const definition = JSON.parse(result.definition ?? '{}') as Record<string, unknown>

    expect(definition.futureField).toEqual({ keep: true })
    expect(definition.name).toBe('新 Kisaki')
    expect(definition.prompt).toBeUndefined()
    expect(file.writeDefinition).toHaveBeenCalledWith('kisaki', expect.any(String))
  })

  it.each([
    ['prompt', (ports: CharacterSaveWorkflowPorts) => vi.mocked(ports.files.writePrompt).mockRejectedValue(new Error('人设不可写'))],
    ['definition', (ports: CharacterSaveWorkflowPorts) => vi.mocked(ports.files.writeDefinition).mockRejectedValue(new Error('定义不可写'))],
  ] as const)('每个必要写入阶段失败时停止后续步骤（%s）', async (step, fail) => {
    const { ports, calls } = makePorts()
    fail(ports)

    const result = await saveCharacter(request(), ports)

    expect(result.status).toBe('failed')
    expect(result.success).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ step, reason: expect.any(String), ignorable: false })
    expect(calls).toEqual(step === 'prompt' ? [] : ['prompt'])
    expect(ports.refreshCache).not.toHaveBeenCalled()
    expect(ports.broadcastCharactersChanged).not.toHaveBeenCalled()
  })

  it('孤儿图、缓存和广播失败都会保留诊断并继续完成后续阶段', async () => {
    const { ports, calls } = makePorts()
    vi.mocked(ports.files.deleteImage).mockRejectedValue(new Error('图片已被外部删除'))
    vi.mocked(ports.refreshCache).mockImplementation(async () => {
      calls.push('cache')
      throw new Error('缓存刷新失败')
    })
    vi.mocked(ports.broadcastCharactersChanged).mockImplementation(async () => {
      calls.push('broadcast')
      throw new Error('广播失败')
    })

    const result = await saveCharacter(request(), ports)

    expect(result).toMatchObject({ status: 'saved', success: true })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ step: 'orphan-images', filename: 'orphan.png', ignorable: true, reason: '图片已被外部删除' }),
      expect.objectContaining({ step: 'cache', ignorable: true, reason: '缓存刷新失败' }),
      expect.objectContaining({ step: 'broadcast', ignorable: true, reason: '广播失败' }),
    ])
    expect(calls).toEqual(['prompt', 'definition', 'cache', 'broadcast'])
    expect(result.completedSteps).toEqual(['prompt', 'definition', 'orphan-images', 'cache', 'broadcast'])
  })

  it('Live2D 保存不把未参与编辑的图片误判为孤儿图', async () => {
    const { ports, file } = makePorts()

    const result = await saveCharacter(request({ render: 'live2d', edits: { ...edits, images: undefined } }), ports)

    expect(result.orphanedFiles).toEqual([])
    expect(file.deleteImage).not.toHaveBeenCalled()
  })
})
