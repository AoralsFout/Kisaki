/**
 * 密钥存储封装：优先系统密钥链（OS Keychain），回退本地加密。
 *
 * 设计目标（v1.0 密钥链改造）：
 * - 敏感明文（API Key）只存在于系统密钥链（Windows Credential Manager /
 *   macOS Keychain / Linux Secret Service），不再与「加密主密钥」一起落在
 *   localStorage，避免本地攻击者一次性取走全部凭据。
 * - 密钥链不可用（非 Tauri 浏览器环境、Linux 无桌面密钥服务）时，
 *   自动回退到 crypto.ts 的本地加密方案，功能不中断。
 * - 旧数据（本地加密 / 明文）首次加载时自动迁移到密钥链。
 */
import { invoke } from '@tauri-apps/api/core'
import { createLogger } from './logger'
import { encrypt, resolveStoredSecret } from './crypto'

const log = createLogger('SecretStore')

/** 各类密钥在密钥链中的条目名（account 字段） */
export type SecretKind = 'ai_api_key' | 'cosyvoice_api_key' | 'search_api_key'

export type SecretStorage = 'keychain' | 'local'

let _keychainOk: boolean | null = null

/** 探测密钥链是否可用（调用一次 get，条目不存在返回 null 也算可用） */
async function keychainAvailable(): Promise<boolean> {
  if (_keychainOk !== null) return _keychainOk
  try {
    await invoke<string | null>('secure_store_get', { key: '__probe__' })
    _keychainOk = true
  } catch (e) {
    log.warn('系统密钥链不可用，回退本地加密存储: %s', (e as Error)?.message || String(e))
    _keychainOk = false
  }
  return _keychainOk
}

/** 写入密钥链；不可用或写入失败返回 false */
export async function keychainSet(kind: SecretKind, value: string): Promise<boolean> {
  if (!(await keychainAvailable())) return false
  try {
    await invoke('secure_store_set', { key: kind, value })
    return true
  } catch (e) {
    log.error('写入密钥链失败（%s），回退本地存储', (e as Error)?.message || String(e))
    _keychainOk = false // 写入失败视为不可用，避免每次重试
    return false
  }
}

/** 从密钥链读取；不可用 / 条目缺失返回 null */
export async function keychainGet(kind: SecretKind): Promise<string | null> {
  if (!(await keychainAvailable())) return null
  try {
    return await invoke<string | null>('secure_store_get', { key: kind })
  } catch (e) {
    log.error('读取密钥链失败（%s）', (e as Error)?.message || String(e))
    return null
  }
}

/** 删除密钥链条目（清除配置时调用，尽力而为） */
export async function keychainDelete(kind: SecretKind): Promise<void> {
  if (!(await keychainAvailable())) return
  try {
    await invoke('secure_store_delete', { key: kind })
  } catch { /* 忽略：条目可能本就不存在 */ }
}

/**
 * 保存密钥：优先密钥链。
 * @returns storage='keychain' 时 value 为空串（明文只存密钥链，配置里不留）；
 *          storage='local' 时 value 为本地加密密文。
 */
export async function persistSecret(
  kind: SecretKind,
  plaintext: string,
): Promise<{ value: string; storage: SecretStorage }> {
  if (await keychainSet(kind, plaintext)) {
    return { value: '', storage: 'keychain' }
  }
  return { value: await encrypt(plaintext), storage: 'local' }
}

/**
 * 读取密钥（供各配置加载器使用）。
 *
 * - keyStorage==='keychain'：从密钥链取明文；取不到视为凭据丢失（返回 null）。
 * - 否则按旧方案解析本地密文/明文；若密钥链当前可用则顺手迁移到密钥链
 *   （返回 needsResave=true，调用方写入空 apiKey + keyStorage='keychain'）。
 */
export async function resolveSecret(
  kind: SecretKind,
  stored: string,
  storageMarker: 'keychain' | undefined,
  looksPlaintext: (k: string) => boolean,
): Promise<{ key: string | null; needsResave: boolean; storage: SecretStorage }> {
  if (storageMarker === 'keychain') {
    const k = await keychainGet(kind)
    if (k) return { key: k, needsResave: false, storage: 'keychain' }
    log.error('密钥链中找不到 %s（可能被清理或换机），需要重新配置', kind)
    return { key: null, needsResave: false, storage: 'keychain' }
  }

  const r = await resolveStoredSecret(stored, looksPlaintext)
  if (r.key === null) return { key: null, needsResave: false, storage: 'local' }

  // 本地数据 → 若密钥链可用则迁移
  if (await keychainSet(kind, r.key)) {
    return { key: r.key, needsResave: true, storage: 'keychain' }
  }
  return { key: r.key, needsResave: r.needsResave, storage: 'local' }
}
