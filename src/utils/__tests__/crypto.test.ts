/**
 * 本地加密工具单元测试
 *
 * 覆盖：
 * - isEncrypted 前缀检测
 * - encrypt / decrypt 往返（Web Crypto 可用时）
 * - 解密失败可检测（损坏 / 主密钥丢失不再静默返回密文）
 * - resolveStoredSecret 的明文 / 新格式 / 损坏识别
 */
import { describe, it, expect, beforeEach } from 'vitest'

const hasWebCrypto =
  typeof crypto !== 'undefined' &&
  typeof crypto.subtle !== 'undefined' &&
  typeof crypto.subtle.encrypt === 'function' &&
  typeof crypto.subtle.decrypt === 'function' &&
  typeof crypto.subtle.importKey === 'function'

describe('isEncrypted', () => {
  it('新格式密文前缀返回 true', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted('kisaki:v1:SGVsbG8=')).toBe(true)
  })

  it('明文 / 短字符串返回 false', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted('sk-test-api-key')).toBe(false)
    expect(mod.isEncrypted('hello')).toBe(false)
    expect(mod.isEncrypted('')).toBe(false)
  })

  it('非字符串返回 false', async () => {
    const mod = await import('../crypto')
    expect(mod.isEncrypted(null as unknown as string)).toBe(false)
  })
})

describe('encrypt / decrypt', () => {
  it('encrypt 输出带版本前缀（Web Crypto 可用时）', async () => {
    const mod = await import('../crypto')
    const result = await mod.encrypt('sk-test-api-key-12345')
    expect(typeof result).toBe('string')
    if (hasWebCrypto) {
      expect(result.startsWith('kisaki:v1:')).toBe(true)
    } else {
      // 无 Web Crypto 时回退到明文
      expect(result).toBe('sk-test-api-key-12345')
    }
  })

  it('encrypt + decrypt 往返', async () => {
    const mod = await import('../crypto')
    if (!hasWebCrypto) return
    const plaintext = 'sk-test-api-key-12345'
    const encrypted = await mod.encrypt(plaintext)
    expect(encrypted).not.toBe(plaintext)
    const decrypted = await mod.decrypt(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  it('decrypt 对非加密输入抛错（不再静默返回原值）', async () => {
    const mod = await import('../crypto')
    await expect(mod.decrypt('sk-plaintext-key')).rejects.toThrow()
  })

  it('decrypt 对损坏密文抛错', async () => {
    const mod = await import('../crypto')
    if (!hasWebCrypto) return
    // 前缀合法但内容乱码 → 应抛错而非静默返回
    await expect(mod.decrypt('kisaki:v1:!!!not-base64!!!')).rejects.toThrow()
  })

  it('空字符串加密', async () => {
    const mod = await import('../crypto')
    const result = await mod.encrypt('')
    expect(typeof result).toBe('string')
  })
})

describe('resolveStoredSecret', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('明文 sk- Key 原样返回并标记需要迁移', async () => {
    const mod = await import('../crypto')
    const r = await mod.resolveStoredSecret('sk-plaintext-key', (k) => k.startsWith('sk-'))
    expect(r.key).toBe('sk-plaintext-key')
    expect(r.needsResave).toBe(true)
  })

  it('新格式密文解密成功且无需迁移', async () => {
    const mod = await import('../crypto')
    if (!hasWebCrypto) return
    const encrypted = await mod.encrypt('sk-secret-value')
    const r = await mod.resolveStoredSecret(encrypted, (k) => k.startsWith('sk-'))
    expect(r.key).toBe('sk-secret-value')
    expect(r.needsResave).toBe(false)
  })

  it('损坏的新格式密文返回 null（调用方应清除配置）', async () => {
    const mod = await import('../crypto')
    if (!hasWebCrypto) return
    const r = await mod.resolveStoredSecret('kisaki:v1:!!!bad!!!', (k) => k.startsWith('sk-'))
    expect(r.key).toBeNull()
  })

  it('空值返回空 Key', async () => {
    const mod = await import('../crypto')
    const r = await mod.resolveStoredSecret('', (k) => k.startsWith('sk-'))
    expect(r.key).toBe('')
    expect(r.needsResave).toBe(false)
  })

  it('无法识别的长字符串按明文保守处理', async () => {
    const mod = await import('../crypto')
    const r = await mod.resolveStoredSecret('some-other-provider-key-1234567890', () => false)
    expect(r.key).toBe('some-other-provider-key-1234567890')
    expect(r.needsResave).toBe(false)
  })
})
