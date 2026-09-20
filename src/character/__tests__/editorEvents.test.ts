import { describe, expect, it, vi } from 'vitest'
import { EVENT_CHARACTERS_CHANGED } from '../../constants'
import { emitCharactersChanged } from '../editorEvents'

describe('角色编辑跨窗口同步协议', () => {
  it('使用既有事件名称且不携带消息 payload', async () => {
    const emit = vi.fn().mockResolvedValue(undefined)

    await emitCharactersChanged(emit)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(EVENT_CHARACTERS_CHANGED)
    expect(emit.mock.calls[0]).toHaveLength(1)
    expect(EVENT_CHARACTERS_CHANGED).toBe('characters-changed')
  })
})
