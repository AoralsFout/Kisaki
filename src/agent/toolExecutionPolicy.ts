import type { ToolCall } from './types'
import { getAutoExecFiles, getScreenCaptureEnabled } from './toolPolicy'
import { getTool } from './registry'
import { approveCommandExecution, prepareCommandExecution } from './tools/command'
import {
  ToolExecutionFailure,
  type PreparedToolExecution,
  type ToolExecutionContext,
  type ToolExecutionPolicy,
} from '../application/tools/toolExecutionCoordinator'

export const toolExecutionPolicy: ToolExecutionPolicy = {
  async prepare(call: ToolCall, context: ToolExecutionContext): Promise<PreparedToolExecution> {
    const prepared: PreparedToolExecution = { call }
    const descriptor = getTool(call.name)?.policy

    if (descriptor?.requiresWorkspace && !context.hasWorkspace) {
      throw new ToolExecutionFailure(
        '当前会话尚未授权工作目录。请提示用户点击「工作区」并重新选择目录后再重试。',
        'WORKSPACE_NOT_SET',
        true,
      )
    }

    if (descriptor?.approval === 'screen-capture') {
      if (!getScreenCaptureEnabled()) {
        throw new ToolExecutionFailure(
          '屏幕截图权限当前未开启，未执行。请提示用户在「设置 → 权限」中开启后再重试。',
          'SCREEN_CAPTURE_DISABLED',
          true,
        )
      }
      prepared.approval = {
        kind: 'screen-capture',
        id: call.id,
        toolName: call.name,
        args: call.arguments,
        target: call.arguments.target === 'primary_monitor' ? 'primary_monitor' : 'cursor_monitor',
        includeKisaki: call.arguments.include_kisaki === true,
        allowedDecisions: ['allow', 'reject'],
      }
    } else if (descriptor?.approval === 'command') {
      let plan
      try {
        plan = await prepareCommandExecution(call.name, call.arguments)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new ToolExecutionFailure(`任务准备失败: ${message}`, 'COMMAND_PREPARATION_FAILED', true)
      }
      prepared.approval = {
        kind: 'command',
        id: call.id,
        toolName: call.name,
        args: call.arguments,
        summary: call.name === 'run_shell'
          ? String(call.arguments.script ?? '')
          : [call.arguments.program, ...(Array.isArray(call.arguments.args) ? call.arguments.args : [])]
            .filter(Boolean).join(' '),
        details: plan,
        allowedDecisions: ['allow', 'reject'],
      }
      prepared.authorize = async () => {
        try {
          const approvalToken = await approveCommandExecution(plan)
          return {
            ...call,
            arguments: {
              ...call.arguments,
              __plan_id: plan.id,
              __approval_token: approvalToken,
              __display_command: plan.display_command,
            },
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new ToolExecutionFailure(`任务批准失败: ${message}`, 'COMMAND_APPROVAL_FAILED', true)
        }
      }
    } else if (
      descriptor?.approval === 'file-session'
      && !getAutoExecFiles()
      && !context.sessionApproval
    ) {
      const pathArgument = descriptor.checkpointArgument ?? 'path'
      prepared.approval = {
        kind: 'file',
        id: call.id,
        toolName: call.name,
        args: call.arguments,
        path: String(call.arguments[pathArgument] ?? ''),
        allowedDecisions: ['allow', 'allow-session', 'reject'],
      }
    }

    if (descriptor?.checkpointArgument) {
      prepared.checkpointPath = String(call.arguments[descriptor.checkpointArgument] ?? '') || undefined
    }
    return prepared
  },
}
