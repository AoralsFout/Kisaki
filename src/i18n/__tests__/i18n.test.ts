/**
 * UI 国际化单元测试
 *
 * 覆盖：4 个 locale 的 key 结构一致性、getUiLanguage/setUiLanguage 行为。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { STORAGE_UI_LANGUAGE, DEFAULT_UI_LANGUAGE } from '../../constants'
import zhCN from '../locales/zh-CN'
import zhTW from '../locales/zh-TW'
import jaJP from '../locales/ja-JP'
import enUS from '../locales/en-US'

/** 递归收集对象的所有叶子 key 路径（如 'app.toolbar.chat'） */
function collectKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeys(v, path))
    } else {
      keys.push(path)
    }
  }
  return keys.sort()
}

describe('i18n - locale key 一致性', () => {
  const base = collectKeys(zhCN)

  const others: Array<[string, Record<string, any>]> = [
    ['zh-TW', zhTW],
    ['ja-JP', jaJP],
    ['en-US', enUS],
  ]

  it('zh-CN 含有大量 key（结构非空）', () => {
    expect(base.length).toBeGreaterThan(50)
  })

  for (const [name, locale] of others) {
    it(`${name} 与 zh-CN 的 key 集合完全一致`, () => {
      const keys = collectKeys(locale)
      const missing = base.filter(k => !keys.includes(k))
      const extra = keys.filter(k => !base.includes(k))
      expect(missing, `${name} 缺少 key`).toEqual([])
      expect(extra, `${name} 多出 key`).toEqual([])
    })
  }
})

describe('i18n - 界面语言偏好', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('未设置时返回默认值 zh-CN', async () => {
    const mod = await import('../index')
    localStorage.removeItem(STORAGE_UI_LANGUAGE)
    expect(mod.getUiLanguage()).toBe(DEFAULT_UI_LANGUAGE)
  })

  it('无效值回退默认', async () => {
    const mod = await import('../index')
    localStorage.setItem(STORAGE_UI_LANGUAGE, 'xx-YY')
    expect(mod.getUiLanguage()).toBe(DEFAULT_UI_LANGUAGE)
  })

  it('setUiLanguage 写入 localStorage 并更新 locale', async () => {
    const mod = await import('../index')
    mod.setUiLanguage('ja-JP')
    expect(localStorage.getItem(STORAGE_UI_LANGUAGE)).toBe('ja-JP')
    expect(mod.default.global.locale.value).toBe('ja-JP')
    expect(mod.getUiLanguage()).toBe('ja-JP')
  })

  it('setUiLanguage 忽略不支持的语言', async () => {
    const mod = await import('../index')
    mod.setUiLanguage('en-US')
    mod.setUiLanguage('xx-YY')
    expect(localStorage.getItem(STORAGE_UI_LANGUAGE)).toBe('en-US')
  })

  it('UI_LANGUAGES 含 4 个语言且首项为简体中文', async () => {
    const mod = await import('../index')
    expect(mod.UI_LANGUAGES.length).toBe(4)
    expect(mod.UI_LANGUAGES[0].value).toBe('zh-CN')
    const values = mod.UI_LANGUAGES.map(l => l.value)
    expect(values).toEqual(['zh-CN', 'zh-TW', 'ja-JP', 'en-US'])
  })

  it('t() 可翻译已知 key 并支持插值', async () => {
    const mod = await import('../index')
    mod.setUiLanguage('zh-CN')
    expect(mod.t('common.save')).toBe('保存')
    expect(mod.t('app.bubble.switchTo', { name: 'Kisaki' })).toContain('Kisaki')
  })
})
