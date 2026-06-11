/**
 * 本地加密工具
 *
 * 使用 Web Crypto API（AES-GCM）对 localStorage 中的敏感数据（API Key）加密。
 * 加密密钥由设备特征派生，不额外存储，攻击者仅凭 localStorage 数据无法还原明文。
 *
 * 注意：这不是绝对安全的解决方案（密钥派生在 JS 中执行），
 * 但相比明文存储已大幅提升安全性，可防御 localStorage 数据泄露场景。
 */

import { createLogger } from './logger'

const log = createLogger('Crypto')

/** 派生密钥的盐值（固定，因为我们要跨会话还原同一密钥） */
const SALT = 'kisaki-v0.1-2024'
/** AES-GCM 初始化向量长度 */
const IV_LENGTH = 12

/**
 * 生成设备指纹作为加密密钥基础
 * 不同浏览器/设备会生成不同的密钥
 */
function getDeviceFingerprint(): string {
  const parts: string[] = [
    navigator.userAgent,
    navigator.language,
    // 非关键特征，用于增加密钥空间
  ]
  // 在 Tauri 中，加上平台信息
  const win = window as any
  if (win.__TAURI_INTERNALS__?.platform) {
    parts.push(String(win.__TAURI_INTERNALS__.platform))
  }
  return parts.join('||')
}

/**
 * 使用 PBKDF2 从设备指纹派生 AES 密钥
 */
async function deriveKey(fingerprint: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(fingerprint),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(SALT),
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
 * 加密明文并返回 base64 编码的密文
 * 格式：base64(iv + ciphertext)
 */
export async function encrypt(plaintext: string): Promise<string> {
  try {
    const key = await deriveKey(getDeviceFingerprint())
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const encoder = new TextEncoder()
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext),
    )
    // 组合 iv + ciphertext
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)
    return btoa(String.fromCharCode(...combined))
  } catch (e) {
    log.warn('加密失败，回退到明文存储', e)
    return plaintext
  }
}

/**
 * 解密 base64 编码的密文，返回明文
 */
export async function decrypt(ciphertext: string): Promise<string> {
  try {
    const key = await deriveKey(getDeviceFingerprint())
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0))
    const iv = combined.slice(0, IV_LENGTH)
    const data = combined.slice(IV_LENGTH)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data,
    )
    return new TextDecoder().decode(decrypted)
  } catch {
    // 解密失败：可能是旧数据（明文）或密钥变化
    // 返回原始字符串，调用方检测到非密文格式时会回退到明文读取
    return ciphertext
  }
}

/**
 * 检测字符串是否为加密格式（base64 特征 + 足够长度）
 */
export function isEncrypted(text: string): boolean {
  try {
    // 解密后的字符串应包含常见 API Key 特征
    const decoded = atob(text)
    return decoded.length > IV_LENGTH && text.length > 20
  } catch {
    return false
  }
}
