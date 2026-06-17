/**
 * 工具权限策略单元测试
 *
 * 覆盖：改文件工具分类、路径提取、自动执行开关（localStorage）、shouldConfirm 决策。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  isMutatingTool,
  mutatingPath,
  mutatingToolNames,
  getAutoExecFiles,
  setAutoExecFiles,
  shouldConfirm,
} from '../toolPolicy'

describe('toolPolicy - 改文件工具分类', () => {
  it('6 个改文件工具被识别', () => {
    for (const n of ['write_file', 'append_file', 'delete_file', 'replace_lines', 'insert_lines', 'delete_lines']) {
      expect(isMutatingTool(n)).toBe(true)
    }
    expect(mutatingToolNames()).toHaveLength(6)
  })

  it('只读 / 动作工具不算改文件', () => {
    for (const n of ['read_file', 'list_dir', 'find_files', 'search_in_files', 'set_character_emotion', 'say']) {
      expect(isMutatingTool(n)).toBe(false)
    }
  })

  it('mutatingPath 从参数取 path；非改文件工具返回 null', () => {
    expect(mutatingPath('write_file', { path: 'a/b.txt', content: 'x' })).toBe('a/b.txt')
    expect(mutatingPath('delete_lines', { path: 'c.txt', start_line: 1, end_line: 2 })).toBe('c.txt')
    expect(mutatingPath('read_file', { path: 'a.txt' })).toBeNull()
  })

  it('mutatingPath 缺 path 时返回空串（不抛错）', () => {
    expect(mutatingPath('write_file', {})).toBe('')
  })
})

describe('toolPolicy - 自动执行开关', () => {
  beforeEach(() => localStorage.clear())

  it('默认关闭', () => {
    expect(getAutoExecFiles()).toBe(false)
  })

  it('set→get 往返', () => {
    setAutoExecFiles(true)
    expect(getAutoExecFiles()).toBe(true)
    setAutoExecFiles(false)
    expect(getAutoExecFiles()).toBe(false)
  })
})

describe('toolPolicy - shouldConfirm 决策', () => {
  it('改文件 + 两个开关都关 → 需要确认', () => {
    expect(shouldConfirm('write_file', { globalAuto: false, sessionAuto: false })).toBe(true)
  })

  it('全局自动 或 本会话自动 → 不确认', () => {
    expect(shouldConfirm('write_file', { globalAuto: true, sessionAuto: false })).toBe(false)
    expect(shouldConfirm('write_file', { globalAuto: false, sessionAuto: true })).toBe(false)
  })

  it('非改文件工具 → 永不确认', () => {
    expect(shouldConfirm('read_file', { globalAuto: false, sessionAuto: false })).toBe(false)
  })
})
