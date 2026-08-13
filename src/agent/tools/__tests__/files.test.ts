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

import {
  readFileTool, writeFileTool, appendFileTool, listDirTool, deleteFileTool,
  replaceLinesTool, insertLinesTool, deleteLinesTool, findFilesTool, searchInFilesTool,
} from '../files'
import { useSessionStore } from '../../../stores/session'

const ROOT = 'C:\\work\\ws'

async function setupSessionWithWorkspace(root: string | null) {
  const store = useSessionStore()
  await store.init()
  if (root) store.setWorkspace(root)
  else store.clearWorkspace()
  return store
}

describe('文件工具 - 未授权工作目录', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    invokeMock.mockReset()
    // 默认模拟非 Tauri 环境：session store 走 localStorage 回退，不产生 invoke 噪音
    invokeMock.mockRejectedValue(new Error('not in tauri'))
  })

  it('未设置工作目录时 read_file 抛出引导性错误', async () => {
    await setupSessionWithWorkspace(null)
    await expect(readFileTool.handler({ path: 'a.txt' })).rejects.toThrow(/工作目录/)
    expect(invokeMock).not.toHaveBeenCalledWith('agent_read_file', expect.anything())
  })

  it('未设置工作目录时 write_file 抛错且不调用后端', async () => {
    await setupSessionWithWorkspace(null)
    await expect(writeFileTool.handler({ path: 'a.txt', content: 'x' })).rejects.toThrow()
    expect(invokeMock).not.toHaveBeenCalledWith('agent_write_file', expect.anything())
  })
})

describe('文件工具 - 已授权工作目录', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    invokeMock.mockReset()
    invokeMock.mockRejectedValue(new Error('not in tauri'))
    await setupSessionWithWorkspace(ROOT)
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

  // ── 按行读取路由 ──
  it('read_file 不带行号 → 走 agent_read_file', async () => {
    invokeMock.mockResolvedValue('whole')
    await readFileTool.handler({ path: 'a.txt' })
    expect(invokeMock).toHaveBeenCalledWith('agent_read_file', { root: ROOT, relPath: 'a.txt' })
  })

  it('read_file 带行号区间 → 走 agent_read_lines', async () => {
    invokeMock.mockResolvedValue('  1 | x')
    const out = await readFileTool.handler({ path: 'a.txt', start_line: 1, end_line: 20 })
    expect(invokeMock).toHaveBeenCalledWith('agent_read_lines', { root: ROOT, relPath: 'a.txt', startLine: 1, endLine: 20 })
    expect(out).toBe('  1 | x')
  })

  it('read_file 仅给 start_line 也走 agent_read_lines（endLine=null）', async () => {
    invokeMock.mockResolvedValue('  5 | y')
    await readFileTool.handler({ path: 'a.txt', start_line: 5 })
    expect(invokeMock).toHaveBeenCalledWith('agent_read_lines', { root: ROOT, relPath: 'a.txt', startLine: 5, endLine: null })
  })

  // ── 按行编辑（共用 agent_edit_lines，operation 区分） ──
  it('replace_lines 以 operation=replace 调用', async () => {
    invokeMock.mockResolvedValue('已替换第 3-4 行（共 1 行新内容）')
    const out = await replaceLinesTool.handler({ path: 'a.txt', start_line: 3, end_line: 4, content: 'new' })
    expect(invokeMock).toHaveBeenCalledWith('agent_edit_lines', {
      root: ROOT, relPath: 'a.txt', operation: 'replace', startLine: 3, endLine: 4, content: 'new',
    })
    expect(out).toMatch(/已替换/)
  })

  it('insert_lines 以 operation=insert 调用（endLine=null）', async () => {
    invokeMock.mockResolvedValue('已在第 2 行前插入 1 行')
    await insertLinesTool.handler({ path: 'a.txt', line: 2, content: 'ins' })
    expect(invokeMock).toHaveBeenCalledWith('agent_edit_lines', {
      root: ROOT, relPath: 'a.txt', operation: 'insert', startLine: 2, endLine: null, content: 'ins',
    })
  })

  it('delete_lines 以 operation=delete 调用（content=null）', async () => {
    invokeMock.mockResolvedValue('已删除第 5-6 行')
    await deleteLinesTool.handler({ path: 'a.txt', start_line: 5, end_line: 6 })
    expect(invokeMock).toHaveBeenCalledWith('agent_edit_lines', {
      root: ROOT, relPath: 'a.txt', operation: 'delete', startLine: 5, endLine: 6, content: null,
    })
  })

  // ── 查找 / 搜索 ──
  it('find_files 传参并把结果列表换行拼接', async () => {
    invokeMock.mockResolvedValue(['a.txt', 'sub/b.txt'])
    const out = await findFilesTool.handler({ pattern: '*.txt' })
    expect(invokeMock).toHaveBeenCalledWith('agent_find_files', { root: ROOT, pattern: '*.txt', relPath: null })
    expect(out).toBe('a.txt\nsub/b.txt')
  })

  it('find_files 无匹配返回占位', async () => {
    invokeMock.mockResolvedValue([])
    expect(await findFilesTool.handler({ pattern: '*.md', path: 'sub' })).toBe('(无匹配)')
    expect(invokeMock).toHaveBeenCalledWith('agent_find_files', { root: ROOT, pattern: '*.md', relPath: 'sub' })
  })

  it('search_in_files 把命中格式化为 path:line: text', async () => {
    invokeMock.mockResolvedValue([
      { path: 'a.txt', line: 3, text: 'TODO foo' },
      { path: 'b.txt', line: 10, text: 'TODO bar' },
    ])
    const out = await searchInFilesTool.handler({ query: 'TODO' })
    expect(invokeMock).toHaveBeenCalledWith('agent_search_in_files', { root: ROOT, query: 'TODO', relPath: null })
    const lines = out.split('\n')
    expect(lines[0]).toBe('a.txt:3: TODO foo')
    expect(lines[1]).toBe('b.txt:10: TODO bar')
  })

  it('search_in_files 无匹配返回占位', async () => {
    invokeMock.mockResolvedValue([])
    expect(await searchInFilesTool.handler({ query: 'zzz' })).toBe('(无匹配)')
  })
})
