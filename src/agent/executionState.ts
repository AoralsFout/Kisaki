import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface OutputEvent {
  job_id: string
  seq: number
  stream: 'stdout' | 'stderr'
  chunk: string
}

export const executionState = reactive({
  active: false,
  jobId: '',
  command: '',
  output: '',
  status: 'idle' as 'idle' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled',
  cancelling: false,
})

let unlisten: UnlistenFn | null = null

async function ensureListener() {
  if (unlisten) return
  unlisten = await listen<OutputEvent>('kisaki-execution-output', event => {
    const payload = event.payload
    if (!executionState.active || payload.job_id !== executionState.jobId) return
    executionState.output += payload.chunk
    // UI 只保留最近 64 KiB；完整日志由 Rust 写入应用缓存。
    if (executionState.output.length > 64 * 1024) {
      executionState.output = executionState.output.slice(-64 * 1024)
    }
  })
}

export async function beginExecutionTracking(jobId: string, command: string) {
  await ensureListener()
  executionState.active = true
  executionState.jobId = jobId
  executionState.command = command
  executionState.output = ''
  executionState.status = 'running'
  executionState.cancelling = false
}

export function finishExecutionTracking(status: typeof executionState.status) {
  const finishedJobId = executionState.jobId
  executionState.status = status
  executionState.cancelling = false
  // 保留结束态片刻供用户确认结果，随后收起状态卡。
  window.setTimeout(() => {
    if (executionState.status === status && executionState.jobId === finishedJobId) {
      executionState.active = false
    }
  }, 3000)
}

export async function cancelActiveExecution() {
  if (!executionState.active || !executionState.jobId || executionState.status !== 'running') return
  executionState.cancelling = true
  await invoke('agent_cancel_execution', { jobId: executionState.jobId })
}
