/**
 * Live2D 清单构建单元测试（buildLive2DCatalog 纯逻辑）
 */
import { describe, it, expect } from 'vitest'
import { buildLive2DCatalog } from '../manifest'

// 仿 Hiyori：无表情，Idle(9) + TapBody(1)
const hiyoriJSON = {
  FileReferences: {
    Moc: 'Hiyori.moc3',
    Motions: {
      Idle: new Array(9).fill({ File: 'm.json' }),
      TapBody: [{ File: 'm04.json' }],
    },
  },
}

describe('buildLive2DCatalog', () => {
  it('无表情时 expressions 为空', () => {
    expect(buildLive2DCatalog(hiyoriJSON).expressions).toEqual([])
  })

  it('动作组发现 + 计数', () => {
    const c = buildLive2DCatalog(hiyoriJSON)
    expect(c.motions.find(m => m.group === 'Idle')?.count).toBe(9)
    expect(c.motions.find(m => m.group === 'TapBody')?.count).toBe(1)
  })

  it('idle/tap 默认推断：Idle→idle，TapBody→tap', () => {
    const c = buildLive2DCatalog(hiyoriJSON)
    expect(c.idleGroup).toBe('Idle')
    expect(c.tapGroup).toBe('TapBody')
  })

  it('注解补描述；无注解回退原始名', () => {
    const json = {
      FileReferences: {
        Expressions: [{ Name: 'exp_01', File: 'e1.exp3.json' }, { Name: 'exp_02', File: 'e2.exp3.json' }],
        Motions: { Greet: [{ File: 'g.json' }] },
      },
    }
    const c = buildLive2DCatalog(json, {
      model: 'm.json',
      expressions: { exp_01: '微笑' },
      motions: { Greet: '打招呼' },
    })
    expect(c.expressions).toEqual([
      { id: 'exp_01', desc: '微笑' },
      { id: 'exp_02', desc: 'exp_02' },
    ])
    expect(c.motions[0]).toEqual({ group: 'Greet', count: 1, desc: '打招呼' })
  })

  it('显式 idleMotionGroup/tapMotionGroup 覆盖推断', () => {
    const json = { FileReferences: { Motions: { A: [{}], B: [{}] } } }
    const c = buildLive2DCatalog(json, { model: 'm.json', idleMotionGroup: 'B', tapMotionGroup: 'A' })
    expect(c.idleGroup).toBe('B')
    expect(c.tapGroup).toBe('A')
  })

  it('无动作组时 idle 回退 "Idle"，tap 为 undefined', () => {
    const c = buildLive2DCatalog({ FileReferences: {} })
    expect(c.idleGroup).toBe('Idle')
    expect(c.tapGroup).toBeUndefined()
  })
})
