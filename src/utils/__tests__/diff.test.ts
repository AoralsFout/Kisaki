/**
 * 行级 diff 工具单元测试
 *
 * 覆盖：新增/删除/上下文识别、纯增、纯删、sliceLines 行区间、计数与截断。
 */
import { describe, it, expect } from 'vitest'
import { lineDiff, sliceLines, countLines } from '../diff'

describe('diff - lineDiff', () => {
  it('相同文本：全为上下文，无增删', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(d.added).toBe(0)
    expect(d.removed).toBe(0)
    expect(d.rows.every(r => r.type === 'ctx')).toBe(true)
  })

  it('中间替换一行：1 删 1 增，首尾为上下文', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.rows[0]).toEqual({ type: 'ctx', text: 'a' })
    expect(d.rows.some(r => r.type === 'del' && r.text === 'b')).toBe(true)
    expect(d.rows.some(r => r.type === 'add' && r.text === 'B')).toBe(true)
  })

  it('空 old → 纯新增', () => {
    const d = lineDiff('', 'x\ny')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(0)
    expect(d.rows.every(r => r.type === 'add')).toBe(true)
  })

  it('空 new → 纯删除（删除文件场景）', () => {
    const d = lineDiff('x\ny', '')
    expect(d.removed).toBe(2)
    expect(d.added).toBe(0)
    expect(d.rows.every(r => r.type === 'del')).toBe(true)
  })

  it('CRLF 与 LF 不应被视为差异', () => {
    const d = lineDiff('a\r\nb', 'a\nb')
    expect(d.added).toBe(0)
    expect(d.removed).toBe(0)
  })

  it('超大输入退化为整块增删并标记截断', () => {
    const big = Array.from({ length: 900 }, (_, i) => `line${i}`).join('\n')
    const d = lineDiff('', big)
    expect(d.truncated).toBe(true)
    expect(d.rows.length).toBeLessThanOrEqual(900)
  })
})

describe('diff - sliceLines', () => {
  const text = 'l1\nl2\nl3\nl4\nl5'

  it('取闭区间 [2,4]', () => {
    expect(sliceLines(text, 2, 4)).toBe('l2\nl3\nl4')
  })

  it('越界自动收敛到文件范围', () => {
    expect(sliceLines(text, 4, 99)).toBe('l4\nl5')
    expect(sliceLines(text, undefined, 2)).toBe('l1\nl2')
  })

  it('start > end 返回空串', () => {
    expect(sliceLines(text, 5, 2)).toBe('')
  })
})

describe('diff - countLines', () => {
  it('空串 0 行；否则按 \\n 计', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\nc')).toBe(3)
  })
})
