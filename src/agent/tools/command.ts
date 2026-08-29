/**
 * 结构化任务执行工具。
 *
 * 模型只描述进程或 Shell 请求；chat policy 先向 Rust 准备不可变计划、展示确认，
 * 再把一次性批准令牌注入 handler。模型无法自行构造或复用批准令牌。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Tool } from '../types'
import { createLogger } from '../../utils/logger'
import { beginExecutionTracking, finishExecutionTracking } from '../executionState'

const log = createLogger('ToolCommand')

export interface ExecutionPlan {
  id: string
  digest: string
  workspace_id: string
  kind: 'process' | 'shell'
  display_command: string
  program: string | null
  args: string[]
  script: string | null
  shell: string | null
  cwd: string
  cwd_relative: string
  timeout_secs: number
  env_keys: string[]
  intent: string
  isolation: 'workspace_unconfined'
  network: 'host_inherited'
  warnings: string[]
}

interface ExecutionResult {
  job_id: string
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled'
  exit_code: number | null
  stdout_tail: string
  stderr_tail: string
  output_ref: string
  duration_ms: number
  timed_out: boolean
  cancelled: boolean
  truncated: boolean
  changed_files: string[]
  changes_truncated: boolean
  isolation: string
}

async function requireWorkspaceId(): Promise<string> {
  const { useSessionStore } = await import('../../stores/session')
  const id = useSessionStore().currentSession?.workspaceId
  if (!id) {
    throw new Error('当前会话尚未授权工作目录。请提示用户点击「工作区」并重新选择目录后再重试。')
  }
  return id
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : []
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
}

/** 由 chat policy 在显示确认卡前调用。 */
export async function prepareCommandExecution(
  toolName: string,
  args: Record<string, any>,
): Promise<ExecutionPlan> {
  const workspaceId = await requireWorkspaceId()
  const common = {
    workspace_id: workspaceId,
    cwd: args.cwd != null ? String(args.cwd) : null,
    timeout_secs: args.timeout_secs != null ? Number(args.timeout_secs) : null,
    env: stringMap(args.env),
    intent: args.intent != null ? String(args.intent) : '',
  }
  const request = toolName === 'run_shell'
    ? { ...common, kind: 'shell', script: String(args.script ?? '') }
    : { ...common, kind: 'process', program: String(args.program ?? ''), args: stringArray(args.args) }
  return invoke<ExecutionPlan>('agent_prepare_execution', { request })
}

/** 用户批准确认卡后签发短期一次性令牌。 */
export function approveCommandExecution(plan: ExecutionPlan): Promise<string> {
  return invoke<string>('agent_approve_execution', { planId: plan.id, digest: plan.digest })
}

function formatResult(result: ExecutionResult): string {
  const lines = [
    `任务状态: ${result.status}`,
    `退出码: ${result.exit_code ?? '无'}`,
    `耗时: ${result.duration_ms} ms`,
    `隔离级别: ${result.isolation}`,
  ]
  if (result.stdout_tail) lines.push(`--- stdout（尾部）---\n${result.stdout_tail}`)
  if (result.stderr_tail) lines.push(`--- stderr（尾部）---\n${result.stderr_tail}`)
  if (result.truncated) lines.push('输出超过保存上限，完整输出已截断。')
  if (result.changed_files.length) {
    lines.push(`工作区变更文件（${result.changed_files.length}${result.changes_truncated ? '+' : ''}）:\n${result.changed_files.join('\n')}`)
  }
  lines.push(`完整日志引用: ${result.output_ref}`)
  return lines.join('\n')
}

async function executeApproved(args: Record<string, any>): Promise<string> {
  const planId = String(args.__plan_id ?? '')
  const approvalToken = String(args.__approval_token ?? '')
  if (!planId || !approvalToken) {
    throw new Error('缺少后端批准的执行计划，拒绝运行')
  }
  await beginExecutionTracking(planId, String(args.__display_command ?? ''))
  try {
    const result = await invoke<ExecutionResult>('agent_execute_plan', { planId, approvalToken })
    finishExecutionTracking(result.status)
    return formatResult(result)
  } catch (error) {
    finishExecutionTracking('failed')
    throw error
  }
}

const commonProperties = {
  cwd: {
    type: 'string',
    description: '相对工作目录的子目录，默认工作区根目录。不能使用绝对路径或 ..',
  },
  timeout_secs: {
    type: 'integer',
    description: '超时秒数，默认 30，范围 1-300',
    default: 30,
  },
  env: {
    type: 'object',
    description: '显式传入的非敏感环境变量。Runner 不继承 API key、token 等敏感变量',
    additionalProperties: { type: 'string' },
  },
  intent: {
    type: 'string',
    description: '用一句话说明执行目的；仅供确认界面参考，实际计划由后端生成',
  },
}

export const runProcessTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_process',
      description:
        '在用户授权的工作目录中启动一个非交互式进程。程序和参数分开传递，不经过 Shell；' +
        '适合构建、测试、Git 查询等绝大多数任务。每次运行都会展示后端规范化计划并等待用户确认。',
      parameters: {
        type: 'object',
        properties: {
          program: { type: 'string', description: 'PATH 中的程序名，或工作区内的相对可执行文件路径' },
          args: { type: 'array', items: { type: 'string' }, description: '逐项传递的参数；不要自行添加 Shell 引号' },
          ...commonProperties,
        },
        required: ['program'],
      },
    },
  },
  handler: executeApproved,
}

export const runShellTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        '高风险逃生工具：仅在确实需要管道、重定向或 Shell 内建语法时使用。' +
        'Windows 使用无配置 PowerShell，其他平台使用 sh；每次运行都必须确认完整脚本。',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: '完整 Shell 脚本；避免交互式命令' },
          ...commonProperties,
        },
        required: ['script'],
      },
    },
  },
  handler: async args => {
    log.warn('执行已批准的 Shell 计划')
    return executeApproved(args)
  },
}
