/**
 * 角色数据迁移单元测试（v0/v1 → v2，新增 render 字段）
 */
import { describe, it, expect } from 'vitest'
import { migrateCharacterData } from '../loader'

describe('migrateCharacterData', () => {
  it('v0（无 version）补全字段并默认 illustration', () => {
    const d = migrateCharacterData({ id: 'a', name: 'A' })
    expect(d.version).toBe(2)
    expect(d.render).toBe('illustration')
    expect(d.poses).toEqual(['standing'])
    expect(d.emotions).toEqual(['idle'])
    expect(d.costumes).toEqual(['default'])
    expect(d.images).toEqual([])
    expect(d.voiceLanguage).toBe('ja-JP')
    expect(d.textLanguage).toBe('zh-CN')
  })

  it('v1 立绘角色升级到 v2，补 render=illustration 且保留原值', () => {
    const d = migrateCharacterData({
      id: 'kanade', name: 'Kanade', version: 1,
      poses: ['standing'], emotions: ['idle', 'happy'], costumes: ['costume_a'],
      images: [{ file: 'x.png', pose: 'standing', costume: 'costume_a', emotions: ['idle'] }],
      voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
    })
    expect(d.version).toBe(2)
    expect(d.render).toBe('illustration')
    expect(d.emotions).toEqual(['idle', 'happy'])
    expect(d.images).toHaveLength(1)
  })

  it('显式 render=live2d 时保留，且 live2d 配置透传', () => {
    const d = migrateCharacterData({
      id: 'hiyori', name: 'Hiyori', version: 1, render: 'live2d',
      live2d: { model: 'live2d/Hiyori/Hiyori.model3.json', idleMotionGroup: 'Idle' },
    })
    expect(d.render).toBe('live2d')
    expect(d.live2d?.model).toBe('live2d/Hiyori/Hiyori.model3.json')
    expect(d.live2d?.idleMotionGroup).toBe('Idle')
  })

  it('已是 v2 不重复迁移，render 原样保留', () => {
    const d = migrateCharacterData({ id: 'a', name: 'A', version: 2, render: 'live2d', live2d: { model: 'm.json' } })
    expect(d.version).toBe(2)
    expect(d.render).toBe('live2d')
  })
})
