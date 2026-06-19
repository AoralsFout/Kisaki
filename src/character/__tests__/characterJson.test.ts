/**
 * buildCharacterJson 单元测试 —— 重点验证 saveAll 数据损坏修复
 */
import { describe, it, expect } from 'vitest'
import { buildCharacterJson } from '../characterJson'

const baseEdits = { voiceLanguage: 'ja-JP', textLanguage: 'zh-CN' }

describe('buildCharacterJson', () => {
  it('live2d 角色：保留 render/live2d，合并配置，不写立绘字段，version→2', () => {
    const data: any = {
      id: 'h', name: 'H', description: 'd', version: 1, prompt: '人设文本',
      render: 'live2d',
      live2d: { model: 'live2d/H/H.model3.json', scale: 1, idleMotionGroup: 'Idle' },
      poses: [], emotions: [], costumes: [], images: [],
    }
    const out = buildCharacterJson(data, 'live2d', {
      ...baseEdits,
      live2d: { scale: 1.5, mouseFollow: false },
    })
    expect(out.render).toBe('live2d')
    expect(out.version).toBe(2)
    expect(out.live2d).toEqual({
      model: 'live2d/H/H.model3.json', scale: 1.5, idleMotionGroup: 'Idle', mouseFollow: false,
    })
    expect(out.prompt).toBeUndefined() // prompt 不写进 json
  })

  it('illustration 角色：覆盖立绘字段，render=illustration', () => {
    const data: any = {
      id: 'k', name: 'K', description: 'd', version: 1, prompt: 'p',
      render: 'illustration',
      poses: ['standing'], emotions: ['idle'], costumes: ['a'],
      images: [{ file: 'x.png', pose: 'standing', costume: 'a', emotions: ['idle'] }],
    }
    const out = buildCharacterJson(data, 'illustration', {
      ...baseEdits,
      poses: ['standing', 'sitting'],
      emotions: ['idle', 'happy'],
      costumes: ['a', 'b'],
      images: [{ file: 'y.png', pose: 'sitting', costume: 'b', emotions: ['happy'] }],
    })
    expect(out.render).toBe('illustration')
    expect(out.poses).toEqual(['standing', 'sitting'])
    expect(out.images).toHaveLength(1)
    expect(out.images[0].file).toBe('y.png')
    expect(out.live2d).toBeUndefined()
  })

  it('保留未知字段（不丢）', () => {
    const data: any = {
      id: 'k', name: 'K', description: 'd', version: 2, prompt: 'p',
      render: 'illustration', poses: ['s'], emotions: ['i'], costumes: ['a'], images: [],
      futureField: { keep: true },
    }
    const out = buildCharacterJson(data, 'illustration', baseEdits)
    expect(out.futureField).toEqual({ keep: true })
  })

  it('voice 空串清除为 undefined（JSON 序列化时被丢弃）', () => {
    const data: any = { id: 'k', name: 'K', description: '', version: 2, prompt: '', render: 'illustration', voice: 'old', poses: [], emotions: [], costumes: [], images: [] }
    const out = buildCharacterJson(data, 'illustration', { ...baseEdits, voice: '' })
    expect(out.voice).toBeUndefined()
  })

  it('缺省 live2d 时合并不报错', () => {
    const data: any = { id: 'h', name: 'H', description: '', version: 1, prompt: '', render: 'live2d', poses: [], emotions: [], costumes: [], images: [] }
    const out = buildCharacterJson(data, 'live2d', { ...baseEdits, live2d: { model: 'm.json' } })
    expect(out.live2d).toEqual({ model: 'm.json' })
  })
})
