import { describe, expect, it, vi } from 'vitest'
import {
  CharacterDeletionWorkflow,
  type CharacterDeletionPorts,
  type CharacterDeletionRequest,
} from './characterDeletion'

function request(overrides: Partial<CharacterDeletionRequest> = {}): CharacterDeletionRequest {
  return {
    targetId: 'alice',
    currentId: 'alice',
    availableIds: ['alice', 'bob', 'cara'],
    confirmed: true,
    ...overrides,
  }
}

function ports(overrides: Partial<CharacterDeletionPorts> = {}): CharacterDeletionPorts {
  return {
    deleteCharacter: vi.fn(async () => undefined),
    refreshDisplayData: vi.fn(async () => ['bob', 'cara']),
    loadReplacement: vi.fn(async () => undefined),
    emitCharactersChanged: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('CharacterDeletionWorkflow', () => {
  it('未明确确认时取消且绝不删除', async () => {
    const p = ports()
    const result = await new CharacterDeletionWorkflow(p).delete(request({ confirmed: false }))

    expect(result).toEqual({ status: 'cancelled', targetId: 'alice' })
    expect(p.deleteCharacter).not.toHaveBeenCalled()
    expect(p.refreshDisplayData).not.toHaveBeenCalled()
    expect(p.emitCharactersChanged).not.toHaveBeenCalled()
  })

  it('删除失败返回统一错误并保持编辑状态', async () => {
    const p = ports({ deleteCharacter: vi.fn(async () => { throw '角色目录不可写' }) })
    const result = await new CharacterDeletionWorkflow(p).delete(request())

    expect(result).toMatchObject({
      status: 'failed',
      targetId: 'alice',
      preserveEditor: true,
      reason: '角色目录不可写',
      error: { code: 'character-deletion-failed', step: 'delete', reason: '角色目录不可写' },
    })
    expect(p.refreshDisplayData).not.toHaveBeenCalled()
    expect(p.loadReplacement).not.toHaveBeenCalled()
    expect(p.emitCharactersChanged).not.toHaveBeenCalled()
  })

  it('删除非当前角色后刷新并广播，但不切换当前编辑状态', async () => {
    const calls: string[] = []
    const p = ports({
      deleteCharacter: vi.fn(async id => { calls.push(`delete:${id}`) }),
      refreshDisplayData: vi.fn(async () => { calls.push('refresh'); return ['alice', 'cara'] }),
      loadReplacement: vi.fn(async id => { calls.push(`load:${id}`) }),
      emitCharactersChanged: vi.fn(async () => { calls.push('broadcast') }),
    })

    const result = await new CharacterDeletionWorkflow(p).delete(request({
      targetId: 'bob',
      currentId: 'alice',
    }))

    expect(result).toEqual({ status: 'succeeded', targetId: 'bob', replacementId: null })
    expect(calls).toEqual(['delete:bob', 'refresh', 'broadcast'])
    expect(p.loadReplacement).not.toHaveBeenCalled()
  })

  it('删除当前角色后按刷新列表首项确定性切换', async () => {
    const calls: string[] = []
    const p = ports({
      deleteCharacter: vi.fn(async () => { calls.push('delete') }),
      refreshDisplayData: vi.fn(async () => { calls.push('refresh'); return ['cara', 'bob'] }),
      loadReplacement: vi.fn(async id => { calls.push(`load:${id}`) }),
      emitCharactersChanged: vi.fn(async () => { calls.push('broadcast') }),
    })

    const result = await new CharacterDeletionWorkflow(p).delete(request())

    expect(result).toEqual({ status: 'succeeded', targetId: 'alice', replacementId: 'cara' })
    expect(calls).toEqual(['delete', 'refresh', 'load:cara', 'broadcast'])
  })

  it('删除最后一个角色时显式进入空状态', async () => {
    const p = ports({ refreshDisplayData: vi.fn(async () => []) })
    const result = await new CharacterDeletionWorkflow(p).delete(request({
      availableIds: ['alice'],
    }))

    expect(result).toEqual({ status: 'succeeded', targetId: 'alice', replacementId: null })
    expect(p.loadReplacement).toHaveBeenCalledWith(null)
    expect(p.emitCharactersChanged).toHaveBeenCalledOnce()
  })

  it('busy 期间阻止重复删除，并在首个流程结束后释放锁', async () => {
    let resolveDelete!: () => void
    const deletionFinished = new Promise<void>(resolve => { resolveDelete = resolve })
    const p = ports({ deleteCharacter: vi.fn(() => deletionFinished) })
    const workflow = new CharacterDeletionWorkflow(p)

    const first = workflow.delete(request())
    await Promise.resolve()
    await expect(workflow.delete(request({ targetId: 'bob' }))).resolves.toEqual({
      status: 'busy',
      targetId: 'bob',
      activeTargetId: 'alice',
    })
    expect(workflow.busy).toBe(true)

    resolveDelete()
    await expect(first).resolves.toMatchObject({ status: 'succeeded' })
    expect(workflow.busy).toBe(false)
  })
})
