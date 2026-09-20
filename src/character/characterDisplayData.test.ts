import { describe, expect, it } from 'vitest'
import {
  getCharacterDisplayName,
  toCharacterDisplayData,
  toCharacterDisplayList,
} from './characterDisplayData'

describe('角色显示数据投影', () => {
  it('保留显式名称和 render', () => {
    expect(toCharacterDisplayData({ id: 'alice', name: '爱丽丝', render: 'live2d' })).toEqual({
      id: 'alice',
      name: '爱丽丝',
      render: 'live2d',
    })
  })

  it('集中处理缺省名称和 render', () => {
    expect(getCharacterDisplayName('kisaki')).toBe('Kisaki')
    expect(toCharacterDisplayData({ id: 'mio', name: null, render: null })).toEqual({
      id: 'mio',
      name: 'Mio',
      render: 'illustration',
    })
  })

  it('每次刷新投影为新的只读快照', () => {
    const first = toCharacterDisplayList([{ id: 'one', name: 'One', render: 'illustration' }])
    const second = toCharacterDisplayList([{ id: 'two', name: 'Two', render: 'live2d' }])

    expect(first).not.toBe(second)
    expect(first).toEqual([{ id: 'one', name: 'One', render: 'illustration' }])
    expect(second).toEqual([{ id: 'two', name: 'Two', render: 'live2d' }])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
  })
})
