/**
 * 用户语言偏好管理（localStorage）
 */
import { createLogger } from '../utils/logger'
import { STORAGE_DISPLAY_LANGUAGE, STORAGE_TYPING_SPEED, DEFAULT_TYPING_SPEED } from '../constants'

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
  log.info('显示语言切换: %s', lang)
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

// ─── 打字机速度 ────────────────────────────────────────

/** 获取打字机速度（ms/字符） */
export function getTypingSpeed(): number {
  try {
    const val = localStorage.getItem(STORAGE_TYPING_SPEED)
    if (val !== null) {
      const n = parseInt(val, 10)
      if (!isNaN(n) && n >= 5 && n <= 500) return n
    }
  } catch { /* ignore */ }
  return DEFAULT_TYPING_SPEED
}

/** 设置打字机速度 */
export function setTypingSpeed(ms: number) {
  localStorage.setItem(STORAGE_TYPING_SPEED, String(Math.round(ms)))
}
