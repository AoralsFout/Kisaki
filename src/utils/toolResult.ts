/** 单条工具结果的软上限；保留头尾，避免错误根因只出现在末尾。 */
export const MAX_TOOL_RESULT_LENGTH = 1600

/** 按模型历史与实时模型上下文共用的规则归一化工具结果。 */
export function normalizeToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_LENGTH) return content
  const marker = `\n…（省略 ${content.length - MAX_TOOL_RESULT_LENGTH} 字符）…\n`
  const available = Math.max(0, MAX_TOOL_RESULT_LENGTH - marker.length)
  const head = Math.ceil(available * 0.6)
  return content.slice(0, head) + marker + content.slice(content.length - (available - head))
}
