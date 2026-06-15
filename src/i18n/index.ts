/**
 * UI 国际化（vue-i18n）
 *
 * 负责「界面语言」——即应用界面文案的语言，区别于 stores/language.ts 管理的
 * 「显示语言」（AI 回复文本的翻译语言）。二者独立、各自持久化。
 *
 * 多窗口说明：主窗口 / 设置 / 日志 / Dev 各为独立 webview，拥有各自的 Vue 应用
 * 和 i18n 实例，但共享同源 localStorage。切换语言时通过 BroadcastChannel 广播，
 * 让其它已打开窗口实时联动。
 */
import { createI18n } from 'vue-i18n'
import { STORAGE_UI_LANGUAGE, DEFAULT_UI_LANGUAGE, CHANNEL_DESKPET_UI_LANG } from '../constants'
import zhCN from './locales/zh-CN'
import zhTW from './locales/zh-TW'
import jaJP from './locales/ja-JP'
import enUS from './locales/en-US'

/** 支持的界面语言列表（顺序即下拉展示顺序） */
export const UI_LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'en-US', label: 'English' },
] as const

const SUPPORTED = UI_LANGUAGES.map(l => l.value) as string[]

/** 读取已保存的界面语言（无效/未设置时回退默认值） */
export function getUiLanguage(): string {
  try {
    const v = localStorage.getItem(STORAGE_UI_LANGUAGE)
    if (v && SUPPORTED.includes(v)) return v
  } catch { /* ignore */ }
  return DEFAULT_UI_LANGUAGE
}

const messages = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'en-US': enUS,
}

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: getUiLanguage(),
  fallbackLocale: 'en-US',
  messages,
})

/** 跨窗口语言同步广播通道 */
let langChannel: BroadcastChannel | null = null
try {
  langChannel = new BroadcastChannel(CHANNEL_DESKPET_UI_LANG)
  langChannel.onmessage = (e) => {
    const lang = e.data?.lang
    if (typeof lang === 'string' && SUPPORTED.includes(lang)) {
      i18n.global.locale.value = lang as any
    }
  }
} catch { /* 非浏览器环境降级 */ }

/** 设置界面语言：持久化 + 立即生效 + 广播到其它窗口 */
export function setUiLanguage(lang: string) {
  if (!SUPPORTED.includes(lang)) return
  try { localStorage.setItem(STORAGE_UI_LANGUAGE, lang) } catch { /* ignore */ }
  i18n.global.locale.value = lang as any
  langChannel?.postMessage({ lang })
}

/** 便捷的非组件场景翻译（store / service 中使用） */
export function t(key: string, named?: Record<string, unknown>): string {
  return named
    ? (i18n.global as any).t(key, named)
    : (i18n.global as any).t(key)
}

export default i18n
