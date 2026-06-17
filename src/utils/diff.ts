/**
 * 行级 diff —— 供「文件修改确认卡」展示改动预览
 *
 * 经典 LCS（最长公共子序列）逐行对比，产出可渲染的行序列（新增/删除/上下文）。
 * 仅用于**预览**：真正的写入由 Rust 执行，故对换行风格等细节的轻微差异不敏感。
 * 为防超大文件拖垮 UI，超过行数上限时退化为「整块删除 + 整块新增」并标记截断。
 */

/** 一行 diff 结果 */
export interface DiffRow {
  type: 'add' | 'del' | 'ctx'
  text: string
}

/** diff 预览模型 */
export interface DiffPreview {
  rows: DiffRow[]
  /** 是否因过大而被截断 / 退化 */
  truncated: boolean
  added: number
  removed: number
}

/** 行数护栏：两侧合计超过此值则不做 LCS，直接整块对比 */
const MAX_DIFF_LINES = 800
/** 预览最多渲染的行数（再多则截断显示） */
const MAX_PREVIEW_ROWS = 400

/** 按 \n 切行；空串视为「无行」（而非一行空字符串），与文件语义一致 */
function toLines(text: string): string[] {
  if (text === '') return []
  // 归一化换行，去掉行尾 \r，避免 CRLF/LF 差异污染 diff
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

/** 统计行数（供调用方决定是否展示） */
export function countLines(text: string): number {
  return toLines(text).length
}

/**
 * 计算 old → new 的行级 diff。
 */
export function lineDiff(oldText: string, newText: string): DiffPreview {
  const a = toLines(oldText)
  const b = toLines(newText)

  // 过大：退化为整块删除 + 整块新增，避免 O(m*n) LCS 卡顿
  if (a.length + b.length > MAX_DIFF_LINES) {
    const rows: DiffRow[] = []
    for (const t of a) rows.push({ type: 'del', text: t })
    for (const t of b) rows.push({ type: 'add', text: t })
    return finalize(rows, true)
  }

  const m = a.length
  const n = b.length
  // dp[i][j] = LCS(a[i..], b[j..]) 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] })
      i++
    } else {
      rows.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < m) rows.push({ type: 'del', text: a[i++] })
  while (j < n) rows.push({ type: 'add', text: b[j++] })

  return finalize(rows, false)
}

function finalize(rows: DiffRow[], degraded: boolean): DiffPreview {
  const added = rows.filter(r => r.type === 'add').length
  const removed = rows.filter(r => r.type === 'del').length
  let truncated = degraded
  let out = rows
  if (rows.length > MAX_PREVIEW_ROWS) {
    out = rows.slice(0, MAX_PREVIEW_ROWS)
    truncated = true
  }
  return { rows: out, truncated, added, removed }
}

/**
 * 取整文件文本的 1-based 闭区间 [start, end] 行，重新拼成文本（不含行号）。
 * 供 replace_lines / delete_lines 提取「将被改动的原始区间」做 diff。
 */
export function sliceLines(fullText: string, start?: number, end?: number): string {
  const lines = toLines(fullText)
  const s = Math.max(1, start ?? 1)
  const e = Math.min(lines.length, end ?? lines.length)
  if (s > e) return ''
  return lines.slice(s - 1, e).join('\n')
}
