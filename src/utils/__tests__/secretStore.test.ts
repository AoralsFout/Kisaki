/**
 * 密钥存储封装单元测试
 *
 * 覆盖：密钥链可用（写入/读取）、密钥链不可用回退本地加密、
 * 旧数据迁移到密钥链、密钥链条目丢失判定。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

beforeEach(() => {
  // 清模块缓存，重置密钥链可用性探测状态
  vi.resetModules()
  localStorage.clear()
  invokeMock.mockReset()
  // 默认：密钥链可用（探测返回 null 也算可用）但条目为空
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'secure_store_get') return Promise.resolve(null)
    return Promise.resolve()
  })
})

async function loadSecretStore() {
  return await import('../secretStore')
}

describe('persistSecret', () => {
  it('密钥链可用时写入密钥链，配置里不留明文', async () => {
    const mod = await loadSecretStore()
    const r = await mod.persistSecret('ai_api_key', 'sk-secret-123')

    expect(r).toEqual({ value: '', storage: 'keychain' })
    expect(invokeMock).toHaveBeenCalledWith('secure_store_set', {
      key: 'ai_api_key',
      value: 'sk-secret-123',
    })
  })

  it('密钥链不可用时回退本地加密', async () => {
    invokeMock.mockRejectedValue(new Error('no keyring'))
    const mod = await loadSecretStore()
    const r = await mod.persistSecret('cosyvoice_api_key', 'sk-cv-456')

    expect(r.storage).toBe('local')
    expect(r.value).not.toBe('sk-cv-456')
    expect(invokeMock).not.toHaveBeenCalledWith('secure_store_set', {
      key: 'cosyvoice_api_key',
      value: 'sk-cv-456',
    })
  })
})

describe('resolveSecret', () => {
  it('keyStorage=keychain 时从密钥链读明文', async () => {
    invokeMock.mockImplementation((cmd: string, args: { key?: string }) => {
      if (cmd === 'secure_store_get' && args.key === 'ai_api_key') {
        return Promise.resolve('sk-from-keychain')
      }
      return Promise.resolve(null)
    })
    const mod = await loadSecretStore()

    const r = await mod.resolveSecret(
      'ai_api_key',
      '',
      'keychain',
      (k) => k.startsWith('sk-'),
    )
    expect(r.key).toBe('sk-from-keychain')
    expect(r.needsResave).toBe(false)
    expect(r.storage).toBe('keychain')
  })

  it('keychain 标记但条目丢失 → key=null（提示重新配置）', async () => {
    const mod = await loadSecretStore()
    const r = await mod.resolveSecret('ai_api_key', '', 'keychain', (k) => k.startsWith('sk-'))
    expect(r.key).toBeNull()
  })

  it('本地旧数据在密钥链可用时自动迁移', async () => {
    const mod = await loadSecretStore()
    const r = await mod.resolveSecret(
      'search_api_key',
      'tvly-plaintext-key',
      undefined,
      (k) => k.startsWith('tvly-'),
    )
    expect(r.key).toBe('tvly-plaintext-key')
    expect(r.needsResave).toBe(true)
    expect(r.storage).toBe('keychain')
    expect(invokeMock).toHaveBeenCalledWith('secure_store_set', {
      key: 'search_api_key',
      value: 'tvly-plaintext-key',
    })
  })

  it('本地旧数据且密钥链不可用时保持本地加密', async () => {
    invokeMock.mockRejectedValue(new Error('no keyring'))
    const mod = await loadSecretStore()
    const r = await mod.resolveSecret(
      'ai_api_key',
      'sk-plaintext-key',
      undefined,
      (k) => k.startsWith('sk-'),
    )
    expect(r.key).toBe('sk-plaintext-key')
    expect(r.storage).toBe('local')
    expect(r.needsResave).toBe(true)
  })
})

describe('keychainDelete', () => {
  it('清除时调用删除命令', async () => {
    const mod = await loadSecretStore()
    await mod.keychainDelete('ai_api_key')
    expect(invokeMock).toHaveBeenCalledWith('secure_store_delete', { key: 'ai_api_key' })
  })
})
