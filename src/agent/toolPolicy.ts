/**
 * 工具策略设置
 *
 * 工具的静态能力、批准和检查点声明位于各 Tool.policy；本模块只持有用户设置。
 */
import {
  STORAGE_AUTO_EXEC_FILES,
  STORAGE_COMMAND_ENABLED,
  STORAGE_SCREEN_CAPTURE_ENABLED,
} from '../constants'

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
    /* 忽略 */
  }
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
    /* 忽略 */
  }
}

// ─── 「允许 AI 请求截屏」开关（默认关闭） ──────────────
// 截图可能包含其他应用和隐私信息。开关只控制是否向模型暴露工具，
// 每一次实际调用仍由 ChatStore 弹出专用确认，且没有会话自动允许选项。

export function getScreenCaptureEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_SCREEN_CAPTURE_ENABLED) === '1'
  } catch {
    return false
  }
}

export function setScreenCaptureEnabled(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_SCREEN_CAPTURE_ENABLED, value ? '1' : '0')
  } catch {
    /* 忽略 */
  }
}
