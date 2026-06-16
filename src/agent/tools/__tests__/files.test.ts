/**
 * 文件读写工具单元测试
 *
 * 覆盖：未授权工作目录时的引导报错、各工具对 Rust 命令的调用与参数、
 * list_dir 的格式化输出。invoke 与 localStorage 均被 mock。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ── mock Tauri invoke ──
const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

// ── mock localStorage（session store 持久化用） ──
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v }),
    removeItem: vi.fn((k: string) => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

import { readFileTool, writeFileTool, appendFileTool, listDirTool, deleteFileTool } from '../files'
import { useSessionStore } from '../../../stores/session'

const ROOT = 'C:\\work\\ws'

function setupSessionWithWorkspace(root: string | null) {
  const store = useSessionStore()
  store.init()
  if (root) store.setWorkspace(root)
  else store.clearWorkspace()
  return store
}

describe('文件工具 - 未授权工作目录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    invokeMock.mockReset()
  })

  it('未设置工作目录时 read_file 抛出引导性错误', async () => {
    setupSessionWithWorkspace(null)
    await expect(readFileTool.handler({ path: 'a.txt' })).rejects.toThrow(/工作目录/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('未设置工作目录时 write_file 抛错且不调用后端', async () => {
    setupSessionWithWorkspace(null)
    await expect(writeFileTool.handler({ path: 'a.txt', content: 'x' })).rejects.toThrow()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('文件工具 - 已授权工作目录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    invokeMock.mockReset()
    setupSessionWithWorkspace(ROOT)
  })

  it('read_file 传入 root+relPath，返回内容', async () => {
    invokeMock.mockResolvedValue('hello')
    const out = await readFileTool.handler({ path: 'notes/a.txt' })
    expect(invokeMock).toHaveBeenCalledWith('agent_read_file', { root: ROOT, relPath: 'notes/a.txt' })
    expect(out).toBe('hello')
  })

  it('read_file 空文件返回占位提示', async () => {
    invokeMock.mockResolvedValue('')
    expect(await readFileTool.handler({ path: 'a.txt' })).toBe('(空文件)')
  })

  it('write_file 调用后端并回报字符数', async () => {
    invokeMock.mockResolvedValue(undefined)
    const out = await writeFileTool.handler({ path: 'a.txt', content: 'abc' })
    expect(invokeMock).toHaveBeenCalledWith('agent_write_file', { root: ROOT, relPath: 'a.txt', content: 'abc' })
    expect(out).toMatch(/已写入 a\.txt/)
    expect(out).toMatch(/3/)
  })

  it('append_file 调用后端并回报', async () => {
    invokeMock.mockResolvedValue(undefined)
    const out = await appendFileTool.handler({ path: 'log.txt', content: 'line' })
    expect(invokeMock).toHaveBeenCalledWith('agent_append_file', { root: ROOT, relPath: 'log.txt', content: 'line' })
    expect(out).toMatch(/已追加到 log\.txt/)
  })

  it('delete_file 调用后端并回报', async () => {
    invokeMock.mockResolvedValue(undefined)
    const out = await deleteFileTool.handler({ path: 'old.txt' })
    expect(invokeMock).toHaveBeenCalledWith('agent_delete_file', { root: ROOT, relPath: 'old.txt' })
    expect(out).toMatch(/已删除 old\.txt/)
  })

  it('list_dir 把条目格式化为可读列表（目录在前）', async () => {
    invokeMock.mockResolvedValue([
      { name: 'b.txt', is_dir: false, size: 10 },
      { name: 'sub', is_dir: true, size: 0 },
    ])
    const out = await listDirTool.handler({ path: '' })
    expect(invokeMock).toHaveBeenCalledWith('agent_list_dir', { root: ROOT, relPath: '' })
    const lines = out.split('\n')
    expect(lines[0]).toContain('📁 sub/')
    expect(lines[1]).toContain('📄 b.txt')
    expect(lines[1]).toContain('10')
  })

  it('list_dir 空目录返回占位提示', async () => {
    invokeMock.mockResolvedValue([])
    expect(await listDirTool.handler({})).toBe('(空目录)')
  })
})
