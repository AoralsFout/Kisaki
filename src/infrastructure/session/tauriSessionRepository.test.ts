import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionAggregate } from '../../domain/conversation/sessionAggregate'
import { SessionCollection } from '../../domain/conversation/sessionCollection'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { TauriSessionRepository } from './tauriSessionRepository'

function document() {
  return SessionCollection.create(SessionAggregate.create({
    id: 'session-1',
    title: 'New conversation',
    now: 10,
  })).snapshot()
}

describe('TauriSessionRepository', () => {
  beforeEach(() => invokeMock.mockReset())

  it('loads and validates a v2 document', async () => {
    invokeMock.mockResolvedValue(JSON.stringify(document()))

    await expect(new TauriSessionRepository().load()).resolves.toEqual(document())
    expect(invokeMock).toHaveBeenCalledWith('sessions_v2_load')
  })

  it('rejects legacy documents instead of adding compatibility branches', async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ currentId: 'old', sessions: [] }))

    await expect(new TauriSessionRepository().load()).rejects.toThrow('Unsupported session document schema')
  })

  it('validates before writing and uses the isolated v2 command', async () => {
    invokeMock.mockResolvedValue(undefined)

    await new TauriSessionRepository().save(document())

    expect(invokeMock).toHaveBeenCalledWith('sessions_v2_save', {
      data: JSON.stringify(document()),
    })
  })

  it('does not invoke Rust for an invalid document', async () => {
    const invalid = { ...document(), schemaVersion: 1 } as never

    await expect(new TauriSessionRepository().save(invalid)).rejects.toThrow('Unsupported session document schema')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
