import { describe, expect, it } from 'vitest'
import { chooseCharacterAfterDelete } from '../editorSafety'

describe('删除角色后的安全切换', () => {
  it('删除当前角色后切换到刷新列表中的第一个角色', () => {
    expect(chooseCharacterAfterDelete('kisaki', 'kisaki', ['sora', 'kanade'])).toBe('sora')
  })

  it('删除当前角色后列表为空时不加载不存在的角色', () => {
    expect(chooseCharacterAfterDelete('kisaki', 'kisaki', [])).toBeNull()
  })

  it('删除非当前角色时保持当前角色不变', () => {
    expect(chooseCharacterAfterDelete('kisaki', 'sora', ['kisaki'])).toBe('kisaki')
  })
})
