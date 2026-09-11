import { describe, expect, it, vi } from 'vitest'
import { publishSettingsChange, subscribeSettingsChange } from './settingsChangeStream'
import { createMemorySettingsStorage } from './settingsStorage'
import { SecretBackedSettings, type SecretBackedConfig } from './secretBackedSettings'
import type { SecretGateway, SecretKind } from './secretGateway'

interface TestConfig extends SecretBackedConfig {
  model: string
}

const DEFAULTS: TestConfig = { apiKey: '', model: 'default' }

function gateway(overrides: Partial<SecretGateway> = {}) {
  const stored = new Map<SecretKind, string>()
  const gateway: SecretGateway = {
    persist: vi.fn(async (kind: SecretKind, plaintext: string) => {
      stored.set(kind, plaintext)
      return { value: '', storage: 'keychain' as const }
    }),
    resolve: vi.fn(async (kind: SecretKind) => {
      const key = stored.get(kind)
      return key ? { key, needsResave: false, storage: 'keychain' as const } : { key: null, needsResave: false, storage: 'keychain' as const }
    }),
    delete: vi.fn(async (kind: SecretKind) => { stored.delete(kind) }),
    seal: vi.fn(async (plaintext: string) => `sealed:${plaintext}`),
    ...overrides,
  }
  return { gateway, stored }
}

function settings(overrides: Partial<SecretGateway> = {}, storage = createMemorySettingsStorage()) {
  const { gateway: secrets } = gateway(overrides)
  const telemetry = { secretMigrated: vi.fn(), secretUnavailable: vi.fn() }
  return {
    storage,
    secrets,
    telemetry,
    settings: new SecretBackedSettings<TestConfig>(storage, secrets, {
      storageKey: 'test-config',
      defaults: DEFAULTS,
      secretKind: 'ai_api_key',
      looksPlaintext: key => key.startsWith('sk-'),
      telemetry,
    }),
  }
}

describe('SecretBackedSettings', () => {
  it('falls back to defaults when nothing is stored', () => {
    const { settings: repo } = settings()
    expect(repo.load()).toEqual(DEFAULTS)
  })

  it('keeps the plaintext key out of storage and serves it from the decrypt cache', async () => {
    const { settings: repo, storage } = settings()
    await repo.saveSecure({ apiKey: 'sk-secret', model: 'gpt-4o' })

    expect(JSON.parse(storage.read('test-config')!)).toEqual({
      apiKey: '',
      keyStorage: 'keychain',
      model: 'gpt-4o',
    })
    expect(repo.load()).toMatchObject({ apiKey: 'sk-secret', model: 'gpt-4o' })
  })

  it('decrypts on demand when the cache is cold', async () => {
    const { settings: repo, storage, secrets } = settings()
    await repo.saveSecure({ apiKey: 'sk-secret', model: 'gpt-4o' })

    // 新进程：缓存为空，只能从密钥链取回
    const cold = new SecretBackedSettings<TestConfig>(storage, secrets, {
      storageKey: 'test-config',
      defaults: DEFAULTS,
      secretKind: 'ai_api_key',
      looksPlaintext: key => key.startsWith('sk-'),
      telemetry: { secretMigrated: vi.fn(), secretUnavailable: vi.fn() },
    })

    await expect(cold.loadSecure()).resolves.toMatchObject({ apiKey: 'sk-secret' })
  })

  it('clears an unrecoverable key so a corrupt value is never sent to the API', async () => {
    const storage = createMemorySettingsStorage({
      'test-config': JSON.stringify({ apiKey: 'ciphertext', keyStorage: 'keychain', model: 'm' }),
    })
    const { settings: repo, telemetry } = settings({
      resolve: async () => ({ key: null, needsResave: false, storage: 'keychain' }),
    }, storage)

    await expect(repo.loadSecure()).resolves.toMatchObject({ apiKey: '', model: 'm' })
    expect(telemetry.secretUnavailable).toHaveBeenCalledWith('unrecoverable')
    expect(JSON.parse(storage.read('test-config')!).keyStorage).toBeUndefined()
  })

  it('preserves the configuration when the keychain read fails transiently', async () => {
    const storage = createMemorySettingsStorage({
      'test-config': JSON.stringify({ apiKey: '', keyStorage: 'keychain', model: 'm' }),
    })
    const { settings: repo, telemetry } = settings({
      resolve: async () => ({ key: null, needsResave: false, storage: 'keychain', readError: true }),
    }, storage)

    await expect(repo.loadSecure()).resolves.toMatchObject({ apiKey: '' })
    expect(telemetry.secretUnavailable).toHaveBeenCalledWith('transient')
    expect(JSON.parse(storage.read('test-config')!).keyStorage).toBe('keychain')
  })

  it('migrates a legacy plaintext value when the keychain is available', async () => {
    const storage = createMemorySettingsStorage({
      'test-config': JSON.stringify({ apiKey: 'sk-legacy-plaintext', model: 'm' }),
    })
    const { settings: repo } = settings({
      resolve: async () => ({ key: 'sk-legacy-plaintext', needsResave: true, storage: 'keychain' }),
    }, storage)

    await expect(repo.loadSecure()).resolves.toMatchObject({ apiKey: 'sk-legacy-plaintext' })
    expect(JSON.parse(storage.read('test-config')!)).toMatchObject({ apiKey: '', keyStorage: 'keychain' })
  })

  it('re-seals locally when the keychain is unavailable', async () => {
    const storage = createMemorySettingsStorage({
      'test-config': JSON.stringify({ apiKey: 'sk-legacy-plaintext', model: 'm' }),
    })
    const { settings: repo } = settings({
      resolve: async () => ({ key: 'sk-legacy-plaintext', needsResave: true, storage: 'local' }),
    }, storage)

    await repo.loadSecure()
    expect(JSON.parse(storage.read('test-config')!).apiKey).toBe('sealed:sk-legacy-plaintext')
  })

  it('invalidates the decrypt cache and reloads when another window changes the config', async () => {
    const { settings: repo, secrets, storage } = settings()
    await repo.saveSecure({ apiKey: 'sk-first', model: 'm' })

    await secrets.persist('ai_api_key', 'sk-second')
    storage.write('test-config', JSON.stringify({ apiKey: '', keyStorage: 'keychain', model: 'm' }))
    publishSettingsChange(['test-config'])

    await vi.waitFor(() => expect(repo.load().apiKey).toBe('sk-second'))
  })

  it('keeps the decrypt cache when unrelated keys change', async () => {
    const { settings: repo, secrets } = settings()
    await repo.saveSecure({ apiKey: 'sk-first', model: 'm' })
    await secrets.persist('ai_api_key', 'sk-second')

    publishSettingsChange(['other-key'])

    // 只有本配置的键才会失效缓存，否则每次无关变更都要重新解密。
    expect(repo.load().apiKey).toBe('sk-first')
  })
})

describe('settings change stream', () => {
  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSettingsChange(listener)

    publishSettingsChange(['a'])
    publishSettingsChange([])
    unsubscribe()
    publishSettingsChange(['b'])

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(['a'])
  })
})
