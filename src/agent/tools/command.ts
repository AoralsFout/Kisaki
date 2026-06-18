/**
 * 命令执行工具 —— 让 AI 在「用户授权的工作目录」内执行 shell 命令
 *
 * 安全模型：
 *   - 工作目录（workspaceRoot）由用户通过「工作区」按钮手动授权，按会话存储。
 *   - 每次执行都必须用户确认（通过独立的 CommandConfirm 组件），无自动允许。
 *   - 输出写入 <root>/.kisaki_cmd_output/，返回路径给 AI 用 read_file 读取。
 *   - 支持可配置超时，默认 30 秒，超时自动 kill 子进程。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Tool } from '../types'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolCommand')

/** 命令执行结果（与 Rust agent_execute_command 返回值一致） */
interface ExecResult {
  exit_code: number | null
  output_path: string
  timed_out: boolean
}

/**
 * 取当前会话工作目录；未授权则抛出引导性错误。
 * 与 files.ts 的 requireRoot 逻辑相同但独立实现，避免循环依赖。
 */
async function requireRoot(): Promise<string> {
  const { useSessionStore } = await import('../../stores/session')
  const root = useSessionStore().currentSession?.workspaceRoot
  if (!root) {
    throw new Error(
      '当前会话尚未设置工作目录。请提示用户点击界面下方的「工作区」按钮选择一个目录后再重试。',
    )
  }
  return root
}

export const executeCommandTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        '在工作目录内执行一条 shell 命令，输出写入临时文件。' +
        '适合执行构建、测试、git 操作、文本处理等命令行任务。' +
        '命令是非交互式的（不接受 stdin 输入）。' +
        '执行完毕后请用 read_file 读取返回的 output_path 查看输出。' +
        '建议在 read_file 之后，用 replace_lines / insert_lines 等工具处理文件变更。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              '要执行的 shell 命令。' +
              'Windows 使用 cmd.exe 语法，其他平台使用 sh 语法（如 ls -la、npm test、git status）。',
          },
          description: {
            type: 'string',
            description:
              '用一句话描述为什么执行这条命令，展示在确认对话框中帮助用户理解。如「查看 Git 状态」',
          },
          timeout_secs: {
            type: 'integer',
            description: '超时秒数（默认 30，最大 300）',
            default: 30,
          },
        },
        required: ['command'],
      },
    },
  },
  handler: async (args) => {
    const root = await requireRoot()
    const command = String(args.command ?? '')
    const timeoutSecs = args.timeout_secs != null ? Number(args.timeout_secs) : 30

    log.debug('execute_command: %s (timeout=%ds)', command, timeoutSecs)
    const result = await invoke<ExecResult>('agent_execute_command', {
      root,
      command,
      timeoutSecs,
    })

    const lines: string[] = ['命令已执行完毕。']
    lines.push(`退出码: ${result.exit_code ?? '（超时被终止）'}`)
    lines.push(`输出文件: ${result.output_path}`)
    if (result.timed_out) {
      lines.push(`⚠ 命令执行超时（${timeoutSecs} 秒），已强制终止，部分输出已保存。`)
    }
    lines.push('请使用 read_file 读取输出文件内容。')
    return lines.join('\n')
  },
}
