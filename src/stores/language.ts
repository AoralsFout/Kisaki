/**
 * 用户语言偏好管理（localStorage）
 */
import { createLogger } from '../utils/logger'
import { STORAGE_DISPLAY_LANGUAGE } from '../constants'

const log = createLogger('Language')
const DISPLAY_LANG_KEY = STORAGE_DISPLAY_LANGUAGE

/** 支持的语言列表 */
export const SUPPORTED_LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'zh-TW', label: '中文（繁体）' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' },
  { value: 'ru-RU', label: 'Русский' },
]

/** 读取已保存的显示语言（未设置返回 null，供回退判断使用） */
function getStoredDisplayLanguage(): string | null {
  try {
    return localStorage.getItem(DISPLAY_LANG_KEY)
  } catch {
    return null
  }
}

/** 获取用户偏好的显示语言（未设置时回退 zh-CN，供 UI 默认值使用） */
export function getDisplayLanguage(): string {
  return getStoredDisplayLanguage() || 'zh-CN'
}

/** 设置用户偏好的显示语言 */
export function setDisplayLanguage(lang: string) {
  localStorage.setItem(DISPLAY_LANG_KEY, lang)
  log.info("language.set_display_language.info", `显示语言切换: ${lang}`, { lang: lang })
}

/**
 * 获取最终显示语言（优先级：用户设置 > 角色默认 > 'zh-CN'）
 *
 * 注意：读取“原始”存储值而非 getDisplayLanguage()，因为后者在未设置时
 * 会回退到 'zh-CN'，会让 charTextLang 永远不生效。
 */
export function resolveDisplayLanguage(charTextLang?: string): string {
  return getStoredDisplayLanguage() || charTextLang || 'zh-CN'
}
