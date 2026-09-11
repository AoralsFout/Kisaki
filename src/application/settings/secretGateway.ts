export type SecretKind = 'ai_api_key' | 'cosyvoice_api_key' | 'search_api_key'

export type SecretStorage = 'keychain' | 'local'

export interface ResolvedSecret {
  key: string | null
  needsResave: boolean
  storage: SecretStorage
  /** 读取失败（瞬时）而非条目缺失；调用方应保留配置等待重试。 */
  readError?: boolean
}

/** 系统密钥链 + 本地加密回退的端口。 */
export interface SecretGateway {
  persist(kind: SecretKind, plaintext: string): Promise<{ value: string; storage: SecretStorage }>
  resolve(
    kind: SecretKind,
    stored: string,
    storageMarker: 'keychain' | undefined,
    looksPlaintext: (key: string) => boolean,
  ): Promise<ResolvedSecret>
  delete(kind: SecretKind): Promise<void>
  /** 密钥链不可用时使用的本地加密。 */
  seal(plaintext: string): Promise<string>
}
