/**
 * 用户语言偏好管理单元测试
 *
 * 覆盖 getDisplayLanguage、setDisplayLanguage、resolveDisplayLanguage、SUPPORTED_LANGUAGES
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { STORAGE_DISPLAY_LANGUAGE } from '../../constants'

describe('Language - SUPPORTED_LANGUAGES', () => {
  it('包含常见语言', async () => {
    const mod = await import('../language')
    const langs = mod.SUPPORTED_LANGUAGES
    expect(langs.length).toBeGreaterThanOrEqual(8)

    // 应包含中、英、日、韩
    const values = langs.map(l => l.value)
    expect(values).toContain('zh-CN')
    expect(values).toContain('en-US')
    expect(values).toContain('ja-JP')
    expect(values).toContain('ko-KR')
  })

  it('每个语言项有 value 和 label', async () => {
    const mod = await import('../language')
    for (const lang of mod.SUPPORTED_LANGUAGES) {
      expect(lang).toHaveProperty('value')
      expect(lang).toHaveProperty('label')
      expect(typeof lang.value).toBe('string')
      expect(typeof lang.label).toBe('string')
    }
  })

  it('第一项为简体中文', async () => {
    const mod = await import('../language')
    expect(mod.SUPPORTED_LANGUAGES[0].value).toBe('zh-CN')
  })
})

describe('Language - 读取/设置偏好', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认返回 zh-CN', async () => {
    const mod = await import('../language')
    // 确保 localStorage 干净
    localStorage.removeItem(STORAGE_DISPLAY_LANGUAGE)
    expect(mod.getDisplayLanguage()).toBe('zh-CN')
  })

  it('setDisplayLanguage 写入 localStorage', async () => {
    const mod = await import('../language')
    mod.setDisplayLanguage('en-US')
    expect(localStorage.getItem(STORAGE_DISPLAY_LANGUAGE)).toBe('en-US')
  })

  it('getDisplayLanguage 读取 localStorage', async () => {
    const mod = await import('../language')
    localStorage.setItem(STORAGE_DISPLAY_LANGUAGE, 'ja-JP')
    expect(mod.getDisplayLanguage()).toBe('ja-JP')
  })

  it('setDisplayLanguage 后 getDisplayLanguage 返回新值', async () => {
    const mod = await import('../language')
    mod.setDisplayLanguage('ko-KR')
    expect(mod.getDisplayLanguage()).toBe('ko-KR')
  })

  it('localStorage 异常时回退到 zh-CN', async () => {
    const mod = await import('../language')
    // 模拟 localStorage.getItem 抛异常
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })

    expect(mod.getDisplayLanguage()).toBe('zh-CN')

    spy.mockRestore()
  })
})

describe('Language - resolveDisplayLanguage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('用户设置优先', async () => {
    const mod = await import('../language')
    localStorage.setItem(STORAGE_DISPLAY_LANGUAGE, 'en-US')
    expect(mod.resolveDisplayLanguage('ja-JP')).toBe('en-US')
  })

  it('无用户设置时使用角色默认语言', async () => {
    const mod = await import('../language')
    localStorage.removeItem(STORAGE_DISPLAY_LANGUAGE)
    // 未设置显示语言时，应回退到角色的默认文本语言（charTextLang）
    expect(mod.resolveDisplayLanguage('ja-JP')).toBe('ja-JP')
  })

  it('无任何设置时回退到 zh-CN', async () => {
    const mod = await import('../language')
    localStorage.removeItem(STORAGE_DISPLAY_LANGUAGE)
    expect(mod.resolveDisplayLanguage()).toBe('zh-CN')
    expect(mod.resolveDisplayLanguage('')).toBe('zh-CN')
  })
})
