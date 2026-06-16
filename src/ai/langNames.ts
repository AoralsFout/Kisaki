/**
 * 语言代码 → 名称映射
 *
 * 用于在提示词中向模型指代某种语言（如"翻译成日语"）。
 * 各处（系统提示词、翻译兜底）共用此表，避免重复定义。
 */

/** 语言代码 → 中文名称 */
export const LANG_NAMES: Record<string, string> = {
  'zh-CN': '中文（简体）',
  'zh-TW': '中文（繁体）',
  'en-US': '英语',
  'ja-JP': '日语',
  'ko-KR': '韩语',
  'fr-FR': '法语',
  'de-DE': '德语',
  'es-ES': '西班牙语',
  'ru-RU': '俄语',
}

/** 取语言名称，未知代码原样返回 */
export function langName(code: string): string {
  return LANG_NAMES[code] || code
}
