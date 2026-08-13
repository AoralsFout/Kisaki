/**
 * 本地加密工具
 *
 * 使用 Web Crypto API（AES-GCM）对 localStorage 中的敏感数据（API Key）加密。
 *
 * ── 安全边界（务必阅读）──
 * 这是「轻量混淆 + 数据损坏防护」，不是能对抗本地攻击者的强加密：
 * 加密主密钥以随机值生成并保存在 localStorage 中，攻击者只要能读到
 * localStorage 就能同时拿到密钥与密文。它的实际价值：
 *   1. 密文带版本前缀，解密失败可被检测并提示，避免把密文当 Key 发给 API 造成 401；
 *   2. 主密钥稳定（不再依赖 userAgent / language 等易变指纹），
 *      WebView / 系统升级不会导致所有已存 Key 突然不可用；
 *   3. 防止密文被单独复制后离线还原。
 * 更强的方案（OS Keychain / DPAPI / tauri-plugin-stronghold）留作后续。
 */

import { createLogger } from './logger'

const log = createLogger('Crypto')

/** 密文版本前缀：可区分「新格式密文」与旧格式密文 / 明文 */
const PREFIX = 'kisaki:v1:'
/** AES-GCM 初始化向量长度 */
const IV_LENGTH = 12
/** 主密钥在 localStorage 中的存储键 */
const STORAGE_MASTER_KEY = 'kisaki-master-key'
/** 旧版（v0.1）密钥派生盐值——仅用于迁移旧数据 */
const LEGACY_SALT = 'kisaki-v0.1-2024'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 读取（或首次生成）本机主密钥：随机 32 字节，持久化在 localStorage */
function getMasterSecret(): Uint8Array {
  let raw = ''
  try {
    raw = localStorage.getItem(STORAGE_MASTER_KEY) || ''
  } catch { /* ignore */ }
  if (!raw) {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    raw = bytesToBase64(secret)
    try {
      localStorage.setItem(STORAGE_MASTER_KEY, raw)
    } catch { /* 忽略：后续每次会话重新生成 */ }
  }
  return base64ToBytes(raw)
}

/** 用主密钥派生 AES-GCM 密钥（主密钥本身已是高熵随机值，直接导入即可） */
async function getMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    getMasterSecret(),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * 旧版（v0.1）密钥派生：userAgent + language + Tauri platform 指纹。
 * 仅用于迁移历史数据；新数据一律走稳定的主密钥。
 */
async function getLegacyKey(): Promise<CryptoKey> {
  const parts: string[] = [navigator.userAgent, navigator.language]
  const win = window as any
  if (win.__TAURI_INTERNALS__?.platform) {
    parts.push(String(win.__TAURI_INTERNALS__.platform))
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(parts.join('||')),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(LEGACY_SALT),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * 加密明文，返回带版本前缀的密文：`kisaki:v1:<base64(iv+ciphertext)>`。
 * 加密失败时抛错（不回退明文，避免敏感明文落盘）；由调用方决定走密钥链或提示用户。
 */
export async function encrypt(plaintext: string): Promise<string> {
  try {
    const key = await getMasterKey()
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext),
    )
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)
    return PREFIX + bytesToBase64(combined)
  } catch (e) {
    throw new Error('本地加密失败: ' + ((e as Error)?.message || String(e)))
  }
}

/**
 * 解密新格式密文。
 * @throws 输入不是新格式、或主密钥丢失 / 密文损坏时抛出异常（由调用方决定如何处理）
 */
export async function decrypt(ciphertext: string): Promise<string> {
  if (!ciphertext.startsWith(PREFIX)) {
    throw new Error('不是加密格式')
  }
  const key = await getMasterKey()
  const combined = base64ToBytes(ciphertext.slice(PREFIX.length))
  if (combined.length <= IV_LENGTH) {
    throw new Error('密文格式不完整')
  }
  const iv = combined.slice(0, IV_LENGTH)
  const data = combined.slice(IV_LENGTH)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  )
  return new TextDecoder().decode(decrypted)
}

/** 解密旧版（v0.1 无前缀）密文，用于迁移；失败抛异常 */
export async function decryptLegacy(ciphertext: string): Promise<string> {
  const key = await getLegacyKey()
  const combined = base64ToBytes(ciphertext)
  if (combined.length <= IV_LENGTH) {
    throw new Error('旧密文格式不完整')
  }
  const iv = combined.slice(0, IV_LENGTH)
  const data = combined.slice(IV_LENGTH)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  )
  return new TextDecoder().decode(decrypted)
}

/**
 * 从存储值中解析明文 Key（供各配置加载器使用）。
 *
 * - 新格式密文（kisaki:v1: 前缀）：解密成功返回明文；失败返回 null（数据损坏）。
 * - 明显明文（如 sk- / tvly- 前缀或短 Key）：原样返回，标记需要重新加密落盘。
 * - 旧格式密文（无前缀）：尝试旧指纹算法迁移；失败则按明文处理（并标记需重新加密）。
 *
 * @param looksPlaintext 判断某值看起来是明文（而非密文）的回调
 * @returns key=null 表示密文损坏无法恢复；needsResave=true 表示应以新格式重新加密写回
 */
export async function resolveStoredSecret(
  stored: string,
  looksPlaintext: (key: string) => boolean,
): Promise<{ key: string | null; needsResave: boolean }> {
  if (!stored) return { key: '', needsResave: false }

  if (stored.startsWith(PREFIX)) {
    try {
      return { key: await decrypt(stored), needsResave: false }
    } catch (e) {
      log.error(
        '存储的密钥无法解密（主密钥丢失或数据损坏），将清除该配置: %s',
        (e as Error).message,
      )
      return { key: null, needsResave: false }
    }
  }

  if (looksPlaintext(stored)) {
    return { key: stored, needsResave: true }
  }

  // 兼容旧格式：尝试旧指纹算法。解密成功 → 迁移为新格式；失败 → 按明文处理。
  try {
    const legacy = await decryptLegacy(stored)
    if (legacy && legacy !== stored) {
      return { key: legacy, needsResave: true }
    }
  } catch { /* 不是旧格式密文 */ }

  // 既不是新格式密文、也不是可解密的旧格式密文 → 一律视为明文，标记需要重新加密。
  // 修复：Gemini(AIza...)/xAI(xai-...)/Brave(BSA...) 等非 sk-/tvly- 前缀的明文 Key，
  // 之前会被漏判为「已加密」而永远明文落盘。
  return { key: stored, needsResave: true }
}

/** 检测字符串是否为新格式加密数据 */
export function isEncrypted(text: string): boolean {
  return typeof text === 'string' && text.startsWith(PREFIX)
}
