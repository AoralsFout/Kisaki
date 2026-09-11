/**
 * 工具结果的分类与图片收集。
 *
 * 纯函数：把一次工具执行结果翻译成「活动状态 / 会话事实状态 / 是否需要跟进」，
 * 并执行本轮工具输出图片的数量与体积上限。
 */
import type { ToolResult } from '../../agent/types'
import type { ImageAttachment } from '../../ai/types'

/** 单轮工具输出图片的请求级上限，由 ConversationSession 的可调参数给出。 */
export interface ToolImageLimits {
  maxCount: number
  maxBytes: number
}

/** 工具活动状态（与 ConversationToolActivity.status 同形）。 */
export type ToolActivityStatus = 'running' | 'done' | 'error' | 'skipped'

/**
 * 收集单轮工具输出图片并执行请求级数量/体积限制。
 * 返回值表示是否有图片因超限被丢弃，调用方可把提示写进工具文本回执。
 */
export function collectToolImages(
  result: ToolResult,
  collected: ImageAttachment[],
  limits: ToolImageLimits,
): boolean {
  let rejected = false
  let totalBytes = collected.reduce((sum, image) => sum + image.size, 0)
  for (const image of result.images ?? []) {
    if (collected.length >= limits.maxCount || totalBytes + image.size > limits.maxBytes) {
      rejected = true
      continue
    }
    collected.push(image)
    totalBytes += image.size
  }
  return rejected
}

/** 图片被丢弃时追加在工具文本回执之后的说明。 */
export function toolImageLimitNotice(limits: ToolImageLimits): string {
  return `\n部分图片未附加：单轮最多 ${limits.maxCount} 张且总计不超过 ${Math.floor(limits.maxBytes / 1024 / 1024)}MB。`
}

/** 工具结果是否为「被用户拒绝」（executeWithPolicy 拒绝时的前缀）。 */
export function isToolSkipped(result: Pick<ToolResult, 'content' | 'code'>): boolean {
  return result.code === 'USER_REJECTED' || /^用户已拒绝/.test(result.content || '')
}

/** 优先使用结构化状态，兼容旧工具结果时再回退到文本判断。 */
export function isToolError(result: Pick<ToolResult, 'ok' | 'content' | 'code'>): boolean {
  if (isToolSkipped(result)) return false
  if (typeof result.ok === 'boolean') return !result.ok
  return /^(工具执行错误|工具执行失败|错误[:：])/.test(result.content || '')
}

/** 由工具结果内容推断活动状态。 */
export function resultStatus(result: Pick<ToolResult, 'ok' | 'content' | 'code'>): ToolActivityStatus {
  if (isToolSkipped(result)) return 'skipped'
  if (isToolError(result)) return 'error'
  return 'done'
}
