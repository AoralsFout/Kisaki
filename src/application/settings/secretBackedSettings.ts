import type { SecretGateway, SecretKind, SecretStorage } from './secretGateway'
import type { SettingsStoragePort } from './settingsStorage'
import { subscribeSettingsChange } from './settingsChangeStream'

/** 所有带 API Key 的配置文档都遵循同一形状。 */
export interface SecretBackedConfig {
  apiKey: string
  keyStorage?: 'keychain'
}

export type SecretFailureReason = 'transient' | 'unrecoverable'

/** 仓库只描述「发生了什么」，事件名由各配置模块自己绑定。 */
export interface SecretBackedSettingsTelemetry {
  secretMigrated(storage: SecretStorage): void
  secretUnavailable(reason: SecretFailureReason): void
}

export interface SecretBackedSettingsOptions<T extends SecretBackedConfig> {
  /** localStorage 键名，同时作为变更流的匹配键。 */
  storageKey: string
  defaults: T
  secretKind: SecretKind
  /** 判断磁盘上的值是否为旧明文，用于迁移到密钥链。 */
  looksPlaintext(key: string): boolean
  telemetry: SecretBackedSettingsTelemetry
}

/**
 * 一份「配置文档 + 其中的 API Key」的统一生命周期。
 *
 * 承担此前在 AI / TTS / Search 三处各写一遍的逻辑：明文读取、解密缓存、
 * 保存时加密、旧明文迁移、跨窗口失效，以及密钥不可恢复时的降级。
 */
export class SecretBackedSettings<T extends SecretBackedConfig> {
  private decryptedSecret: string | null = null

  constructor(
    private readonly storage: SettingsStoragePort,
    private readonly secrets: SecretGateway,
    private readonly options: SecretBackedSettingsOptions<T>,
  ) {
    subscribeSettingsChange(changedKeys => {
      if (!changedKeys.includes(this.options.storageKey)) return
      // 其它窗口改过这份配置：失效缓存并立即重新解密，避免继续使用旧凭据。
      this.decryptedSecret = null
      void this.loadSecure().catch(() => { /* 下次读取会重试 */ })
    })
  }

  /** 同步读取；密钥字段取解密缓存（未解密时为空）。 */
  load(): T {
    const raw = this.storage.read(this.options.storageKey)
    if (raw) {
      try {
        const parsed = { ...this.options.defaults, ...JSON.parse(raw) } as T
        if (this.decryptedSecret) parsed.apiKey = this.decryptedSecret
        return parsed
      } catch { /* 损坏的配置按默认值处理 */ }
    }
    return { ...this.options.defaults }
  }

  save(config: T): void {
    this.storage.write(this.options.storageKey, JSON.stringify(config))
  }

  /** 保存配置；密钥写密钥链（明文不落盘），不可用时落本地加密。 */
  async saveSecure(config: T): Promise<void> {
    if (!config.apiKey) {
      await this.secrets.delete(this.options.secretKind)
      const { keyStorage: _marker, ...rest } = config
      this.save({ ...rest, apiKey: '' } as T)
      return
    }

    this.decryptedSecret = config.apiKey
    const { value, storage } = await this.secrets.persist(this.options.secretKind, config.apiKey)
    this.save({
      ...config,
      apiKey: value,
      keyStorage: storage === 'keychain' ? 'keychain' : undefined,
    })
  }

  /** 读取配置并解出密钥，必要时顺手完成旧明文迁移。 */
  async loadSecure(): Promise<T> {
    const config = this.load()
    if (this.decryptedSecret) return { ...config, apiKey: this.decryptedSecret }
    if (!config.apiKey && config.keyStorage !== 'keychain') return config

    const resolved = await this.secrets.resolve(
      this.options.secretKind,
      config.apiKey,
      config.keyStorage,
      this.options.looksPlaintext,
    )
    if (resolved.key === null) {
      if (resolved.readError) {
        // 瞬时读取失败：保留 keyStorage 标记，不清除配置，下次重试
        this.options.telemetry.secretUnavailable('transient')
        return { ...config, apiKey: '' }
      }
      // 条目丢失 / 密文损坏：清掉 Key，避免把乱码发给服务端
      this.options.telemetry.secretUnavailable('unrecoverable')
      const { keyStorage: _marker, ...rest } = config
      this.save({ ...rest, apiKey: '' } as T)
      return { ...rest, apiKey: '' } as T
    }

    this.decryptedSecret = resolved.key
    if (resolved.needsResave) {
      this.options.telemetry.secretMigrated(resolved.storage)
      await this.resaveResolvedKey(config, resolved.key, resolved.storage)
    }
    return { ...config, apiKey: resolved.key }
  }

  private async resaveResolvedKey(config: T, key: string, storage: SecretStorage): Promise<void> {
    if (storage === 'keychain') {
      this.save({ ...config, apiKey: '', keyStorage: 'keychain' })
      return
    }
    // 密钥链不可用：把明文换成新的本地密文
    this.save({ ...config, apiKey: await this.secrets.seal(key), keyStorage: undefined })
  }
}
