/**
 * 工具权限策略 —— 哪些工具会改文件、改的是哪个路径，以及「自动执行」开关
 *
 * 单独成模块的原因：
 *   - 工具 handler（tools/files.ts）保持「纯转发」，确认/备份逻辑不侵入它们
 *     （现有 files.test.ts 直接断言 handler→invoke，不应被打断）。
 *   - 分类信息与图标（toolMeta.ts）一样是「关于工具的元信息」，集中声明便于维护。
 */
import { STORAGE_AUTO_EXEC_FILES, STORAGE_COMMAND_ENABLED } from '../constants'

/**
 * 会修改文件的工具 → 从其参数中取「受影响的相对路径」。
 * 只读工具（read_file / list_dir / find_files / search_in_files）不在此列。
 */
const MUTATING_TOOLS: Record<string, (args: Record<string, any>) => string> = {
  write_file: a => String(a.path ?? ''),
  append_file: a => String(a.path ?? ''),
  delete_file: a => String(a.path ?? ''),
  replace_lines: a => String(a.path ?? ''),
  insert_lines: a => String(a.path ?? ''),
  delete_lines: a => String(a.path ?? ''),
}

/** 该工具是否会修改文件 */
export function isMutatingTool(name: string): boolean {
  return name in MUTATING_TOOLS
}

/** 取该工具调用受影响的相对路径；非改文件工具返回 null */
export function mutatingPath(name: string, args: Record<string, any>): string | null {
  const fn = MUTATING_TOOLS[name]
  return fn ? fn(args || {}) : null
}

/** 全部改文件工具名（供测试 / 展示用） */
export function mutatingToolNames(): string[] {
  return Object.keys(MUTATING_TOOLS)
}

// ─── 高风险工具 —— 每次执行都需用户确认，无「自动允许」选项 ──────────

/** 高风险工具名称 → (args) => 摘要文本（展示在确认对话框中） */
const DANGEROUS_TOOLS: Record<string, (args: Record<string, any>) => string> = {
  run_process: a => [a.program, ...(Array.isArray(a.args) ? a.args : [])].filter(Boolean).join(' '),
  run_shell: a => String(a.script ?? ''),
}

/** 该工具是否属于高风险类别（每次执行都需确认） */
export function isDangerousTool(name: string): boolean {
  return name in DANGEROUS_TOOLS
}

/** 获取高风险工具的摘要文本（用于确认对话框展示） */
export function dangerousToolSummary(name: string, args: Record<string, any>): string {
  const fn = DANGEROUS_TOOLS[name]
  return fn ? fn(args || {}) : ''
}

/** 全部高风险工具名 */
export function dangerousToolNames(): string[] {
  return Object.keys(DANGEROUS_TOOLS)
}

// ─── 全局「自动执行文件修改」开关（localStorage 持久化） ──────────────

/** 读取全局自动执行开关（默认关闭：改文件需逐次确认） */
export function getAutoExecFiles(): boolean {
  try {
    return localStorage.getItem(STORAGE_AUTO_EXEC_FILES) === '1'
  } catch {
    return false
  }
}

/** 设置全局自动执行开关 */
export function setAutoExecFiles(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_AUTO_EXEC_FILES, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/**
 * 是否需要就该工具调用向用户弹确认。
 * 纯函数（开关从参数注入），便于单测。
 * 规则：是改文件工具 且 未开全局自动 且 未开本会话自动 → 需要确认。
 */
export function shouldConfirm(
  name: string,
  opts: { globalAuto: boolean; sessionAuto: boolean },
): boolean {
  if (!isMutatingTool(name)) return false
  return !opts.globalAuto && !opts.sessionAuto
}

// ─── 「允许 AI 执行 shell 命令」开关（默认关闭） ──────────────
// 命令以当前用户完整权限运行（无 OS 沙箱），风险最高，因此默认不把
// run_process / run_shell 暴露给模型，需用户在设置中显式开启。

/** 读取「允许 AI 执行命令」开关（默认关闭） */
export function getCommandEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_COMMAND_ENABLED) === '1'
  } catch {
    return false
  }
}

/** 设置「允许 AI 执行命令」开关 */
export function setCommandEnabled(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_COMMAND_ENABLED, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}
