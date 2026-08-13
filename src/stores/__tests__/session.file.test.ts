/**
 * 会话文件持久化（Tauri 模式）单元测试
 *
 * 覆盖：从文件加载、localStorage 旧数据迁移到文件、文件模式下的保存。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

async function loadSessionStore() {
  const { useSessionStore } = await import('../session')
  return useSessionStore
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  invokeMock.mockReset()
  // 默认：文件不存在（Tauri 可用）
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'sessions_load') return Promise.resolve(null)
    return Promise.resolve()
  })
})

describe('会话文件持久化', () => {
  it('文件存在时从文件恢复会话', async () => {
    const saved = JSON.stringify({
      sessions: [
        {
          id: 'file-session-1',
          name: '文件会话',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      currentId: 'file-session-1',
    })
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'sessions_load') return Promise.resolve(saved)
      return Promise.resolve()
    })

    const useSessionStore = await loadSessionStore()
    const store = useSessionStore()
    await store.init()

    expect(store.ready).toBe(true)
    expect(store.sessionList).toHaveLength(1)
    expect(store.currentSessionId).toBe('file-session-1')
    expect(store.sessionList[0].name).toBe('文件会话')
  })

  it('localStorage 旧数据迁移到文件并清除旧副本', async () => {
    // 预置旧 localStorage 数据
    localStorage.setItem('deskpet-sessions', JSON.stringify([
      {
        id: 'legacy-1',
        name: '旧会话',
        messages: [{ id: 'm1', role: 'user', text: 'hi', timestamp: 1 }],
        createdAt: 1,
        updatedAt: 2,
      },
    ]))
    localStorage.setItem('deskpet-current-session', JSON.stringify('legacy-1'))

    const useSessionStore = await loadSessionStore()
    const store = useSessionStore()
    await store.init()

    // 应写入文件（sessions_save 被调用）
    expect(invokeMock).toHaveBeenCalledWith(
      'sessions_save',
      expect.objectContaining({ data: expect.stringContaining('legacy-1') }),
    )
    // 旧副本应被清除
    expect(localStorage.getItem('deskpet-sessions')).toBeNull()
    expect(localStorage.getItem('deskpet-current-session')).toBeNull()
    // 数据仍在内存中
    expect(store.sessionList[0].name).toBe('旧会话')
    expect(store.currentSessionId).toBe('legacy-1')
  })

  it('文件模式下保存走 sessions_save', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'sessions_load') {
        return Promise.resolve(JSON.stringify({ sessions: [], currentId: '' }))
      }
      return Promise.resolve()
    })

    const useSessionStore = await loadSessionStore()
    const store = useSessionStore()
    await store.init()
    invokeMock.mockClear()

    store.createSession()
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('sessions_save', expect.any(Object))
    })
  })

  it('文件不可用时回退 localStorage', async () => {
    invokeMock.mockRejectedValue(new Error('not in tauri'))
    localStorage.setItem('deskpet-sessions', JSON.stringify([
      {
        id: 'local-1',
        name: '本地会话',
        messages: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ]))
    localStorage.setItem('deskpet-current-session', JSON.stringify('local-1'))

    const useSessionStore = await loadSessionStore()
    const store = useSessionStore()
    await store.init()

    expect(store.sessionList[0].name).toBe('本地会话')
    // 不应调用 sessions_save，也不应删除 localStorage
    expect(invokeMock).not.toHaveBeenCalledWith('sessions_save', expect.any(Object))
    expect(localStorage.getItem('deskpet-sessions')).not.toBeNull()
  })
})
