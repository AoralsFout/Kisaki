/** 将底层异常归一为稳定、可直接展示的角色操作诊断文本。 */
export function characterErrorReason(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (typeof cause === 'string' && cause) return cause
  try {
    const serialized = JSON.stringify(cause)
    if (serialized !== undefined) return serialized
  } catch {
    // 循环对象等不可序列化值继续使用字符串兜底。
  }
  return String(cause)
}
