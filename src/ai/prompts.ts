/**
 * 角色人设提示词 - 后备默认值
 *
 * 仅在角色 JSON 未提供 prompt.txt 时使用。
 * 实际提示词从 public/character/<id>/prompt.txt 加载。
 */

/** 后备默认提示词（简短通用） */
export const DEFAULT_SYSTEM_PROMPT = `你是用户的桌面宠物助手。请用亲切友好的语气和用户交流，保持对话自然流畅。你可以根据需要切换心情和姿势来表达自己。`

/** 获取默认消息列表 */
export function getDefaultMessages() {
  return [{ role: 'system' as const, content: DEFAULT_SYSTEM_PROMPT }]
}
