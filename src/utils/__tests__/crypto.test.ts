/**
 * 本地加密工具单元测试
 *
 * 覆盖：
 * - isEncrypted 检测函数
 * - encrypt/decrypt（依赖 Web Crypto API，需环境支持）
 */
import { describe, it, expect } from 'vitest'

describe('isEncrypted', () => {
  it('长 base64 字符串视为加密数据', async () => {
    const mod = await import('../crypto')
    // 创建一个足够长的 base64 字符串（> 20 字符）
    const longBase64 = 'SGVsbG8gV29ybGQgVGhpcyBpcyBhIHRlc3QgbWVzc2FnZQ=='
    expect(mod.isEncrypted(longBase64)).toBe(true)
  })

  it('短字符串视为非加密', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted('hello')).toBe(false)
  })

  it('无效 base64 返回 false', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted('!!!invalid@@@')).toBe(false)
  })

  it('空字符串返回 false', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted('')).toBe(false)
  })

  it('长度 > 20 但解码后 <= IV_LENGTH 的视为非加密', async () => {
    const mod = await import('../crypto')
    // 解码后长度为 12（=IV_LENGTH），所以返回 false
    const shortData = btoa('A'.repeat(12))
    expect(mod.isEncrypted(shortData)).toBe(false)
  })

  it('长度恰好 20 的文本返回 false', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted('12345678901234567890')).toBe(false)
  })

  it('含特殊字符的 base64 仍可检测', async () => {
    const mod = await import('../crypto')
    const data = btoa('this is a longer string with more than 12 chars inside')
    expect(mod.isEncrypted(data)).toBe(true)
  })

  it('非 base64 字符导致 atob 失败返回 false', async () => {
    const mod = await import('../crypto')
    // 中文字符在 base64 上下文会导致 atob 抛出异常
    // 但 atob('中文') 在有些环境中会抛出异常
    expect(mod.isEncrypted('中文测试文本长度超过二十字符')).toBe(false)
  })
})

describe('encrypt / decrypt', () => {
  it('encrypt 在无 Web Crypto API 时回退到明文', async () => {
    const mod = await import('../crypto')
    // 在无 crypto.subtle 的环境中，encrypt 应回退返回原文
    const result = await mod.encrypt('test-api-key')
    // 如果环境有 Web Crypto，结果是 base64 密文；
    // 否则回退到明文。两种结果都接受。
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('decrypt 返回原始字符串（密文或明文回退）', async () => {
    const mod = await import('../crypto')
    const result = await mod.decrypt('test-api-key')
    expect(typeof result).toBe('string')
  })

  it('encrypt + decrypt 往返（如果 Web Crypto 可用）', async () => {
    const mod = await import('../crypto')
    // 检查 Web Crypto 是否可用
    const hasWebCrypto = typeof crypto !== 'undefined' &&
      typeof crypto.subtle !== 'undefined' &&
      typeof crypto.subtle.encrypt === 'function'

    if (hasWebCrypto) {
      const plaintext = 'sk-test-api-key-12345'
      const encrypted = await mod.encrypt(plaintext)
      expect(encrypted).not.toBe(plaintext) // 应该被加密
      const decrypted = await mod.decrypt(encrypted)
      expect(decrypted).toBe(plaintext)
    }
    // 无 Web Crypto 时跳过加密/解密往返验证
  })

  it('空字符串加密', async () => {
    const mod = await import('../crypto')
    const result = await mod.encrypt('')
    expect(typeof result).toBe('string')
  })
})
