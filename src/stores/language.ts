/**
 * 用户语言偏好管理（localStorage）
 */
import { createLogger } from '../utils/logger'

const log = createLogger('Language')
const DISPLAY_LANG_KEY = 'deskpet-display-language'

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

/** 获取用户偏好的显示语言 */
export function getDisplayLanguage(): string {
  try {
    return localStorage.getItem(DISPLAY_LANG_KEY) || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

/** 设置用户偏好的显示语言 */
export function setDisplayLanguage(lang: string) {
  localStorage.setItem(DISPLAY_LANG_KEY, lang)
  log.info('显示语言切换: %s', lang)
}

/**
 * 获取最终显示语言（优先级：用户设置 > 角色默认 > 'zh-CN'）
 */
export function resolveDisplayLanguage(charTextLang?: string): string {
  const userLang = getDisplayLanguage()
  return userLang || charTextLang || 'zh-CN'
}
