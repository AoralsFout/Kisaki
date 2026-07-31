/**
 * CosyVoice & GPT-SoVITS 配置管理（localStorage）
 */
import type { CosyVoiceConfig, CosyVoiceModel, CosyVoiceRegion, GptSoVitsConfig, TtsProvider } from './types'
import { createLogger } from '../utils/logger'
import { STORAGE_COSYVOICE_CONFIG, STORAGE_GPTSOVITS_CONFIG, STORAGE_TTS_PROVIDER } from '../constants'
import { encrypt, resolveStoredSecret } from '../utils/crypto'

const log = createLogger('TTSConfig')
const STORAGE_KEY = STORAGE_COSYVOICE_CONFIG

/** 默认配置 */
export const DEFAULT_COSYVOICE_CONFIG: CosyVoiceConfig = {
  apiKey: '',
  model: 'cosyvoice-v3-flash',
  region: 'beijing',
}

/** 可用地域 */
export const REGIONS: Record<string, CosyVoiceRegion> = {
  beijing: {
    label: '华北2（北京）',
    wsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    httpUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',
  },
  singapore: {
    label: '新加坡',
    wsUrl: 'wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference',
    httpUrl: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/customization',
    workspaceId: '',
  },
}

/** 可用模型列表 */
export const MODELS: { label: string; value: CosyVoiceModel }[] = [
  { label: 'CosyVoice v3.5 Plus', value: 'cosyvoice-v3.5-plus' },
  { label: 'CosyVoice v3.5 Flash', value: 'cosyvoice-v3.5-flash' },
  { label: 'CosyVoice v3 Plus', value: 'cosyvoice-v3-plus' },
  { label: 'CosyVoice v3 Flash', value: 'cosyvoice-v3-flash' },
  { label: 'CosyVoice v2', value: 'cosyvoice-v2' },
  { label: 'CosyVoice v1', value: 'cosyvoice-v1' },
]

/** 解密后的 API Key 缓存（避免每个 TTS 请求都重新解密） */
let _decryptedApiKeyCache: string | null = null

/** 设置解密缓存（由 loadCosyVoiceConfigSecure 调用） */
export function setDecryptedApiKeyCache(key: string) {
  _decryptedApiKeyCache = key
}

export function loadCosyVoiceConfig(): CosyVoiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = { ...DEFAULT_COSYVOICE_CONFIG, ...JSON.parse(raw) } as CosyVoiceConfig
      // 如果有解密缓存则替换加密的 apiKey
      if (_decryptedApiKeyCache) {
        parsed.apiKey = _decryptedApiKeyCache
      }
      return parsed
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_COSYVOICE_CONFIG }
}

export function saveCosyVoiceConfig(config: CosyVoiceConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  log.debug('CosyVoice 配置已保存 (模型: %s, 地域: %s)', config.model, config.region)
}

export function isCosyVoiceConfigValid(config: CosyVoiceConfig): boolean {
  return Boolean(config.apiKey)
}

/** 保存配置并加密 API Key */
export async function saveCosyVoiceConfigSecure(config: CosyVoiceConfig) {
  if (config.apiKey) {
    // 与 AI 配置保持一致：保存时同步刷新本窗口的解密缓存
    setDecryptedApiKeyCache(config.apiKey)
    const encrypted = await encrypt(config.apiKey)
    saveCosyVoiceConfig({ ...config, apiKey: encrypted })
  } else {
    saveCosyVoiceConfig(config)
  }
}

/** 加载配置并解密 API Key，自动迁移旧明文 */
export async function loadCosyVoiceConfigSecure(): Promise<CosyVoiceConfig> {
  const config = loadCosyVoiceConfig()
  // 已有解密缓存
  if (_decryptedApiKeyCache) return { ...config, apiKey: _decryptedApiKeyCache }

  if (!config.apiKey) return config

  const resolved = await resolveStoredSecret(
    config.apiKey,
    (k) => k.startsWith('sk-') || k.length <= 20,
  )
  if (resolved.key === null) {
    log.error('CosyVoice API Key 解密失败，已清除失效配置，请重新填写')
    const cleaned = { ...config, apiKey: '' }
    saveCosyVoiceConfig(cleaned)
    return cleaned
  }
  setDecryptedApiKeyCache(resolved.key)
  if (resolved.needsResave) {
    const encryptedKey = await encrypt(resolved.key)
    saveCosyVoiceConfig({ ...config, apiKey: encryptedKey })
  }
  return { ...config, apiKey: resolved.key }
}

// 跨窗口配置同步：设置窗口保存后，其它窗口失效解密缓存并重新解密。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    _decryptedApiKeyCache = null
    loadCosyVoiceConfigSecure().catch(() => { /* 静默：下次加载会重试 */ })
  })
}

/** 获取当前配置的 WebSocket URL */
export function getWsUrl(config: CosyVoiceConfig): string {
  const region = REGIONS[config.region]
  if (!region) return REGIONS.beijing.wsUrl
  if (config.region === 'singapore' && region.workspaceId) {
    return region.wsUrl.replace('{WorkspaceId}', region.workspaceId)
  }
  return region.wsUrl
}

/** 获取当前配置的 HTTP API URL */
export function getHttpUrl(config: CosyVoiceConfig): string {
  const region = REGIONS[config.region]
  if (!region) return REGIONS.beijing.httpUrl
  if (config.region === 'singapore' && region.workspaceId) {
    return region.httpUrl.replace('{WorkspaceId}', region.workspaceId)
  }
  return region.httpUrl
}

// ─── GPT-SoVITS 配置 ───────────────────────────────────

const GPTSOVITS_KEY = STORAGE_GPTSOVITS_CONFIG
const PROVIDER_KEY = STORAGE_TTS_PROVIDER

export const DEFAULT_GPTSOVITS_CONFIG: GptSoVitsConfig = {
  apiUrl: 'http://127.0.0.1:9880',
  topK: 15,
  topP: 1.0,
  temperature: 1.0,
  speedFactor: 1.0,
}

export function loadGptSoVitsConfig(): GptSoVitsConfig {
  try {
    const raw = localStorage.getItem(GPTSOVITS_KEY)
    if (raw) {
      return { ...DEFAULT_GPTSOVITS_CONFIG, ...JSON.parse(raw) } as GptSoVitsConfig
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_GPTSOVITS_CONFIG }
}

export function saveGptSoVitsConfig(config: GptSoVitsConfig) {
  localStorage.setItem(GPTSOVITS_KEY, JSON.stringify(config))
  log.debug('GPT-SoVITS 配置已保存 (apiUrl: %s)', config.apiUrl)
}

export function isGptSoVitsConfigValid(config: GptSoVitsConfig): boolean {
  return Boolean(config.apiUrl)
}

/** 获取当前 TTS 提供者 */
export function getTtsProvider(): TtsProvider {
  try {
    const raw = localStorage.getItem(PROVIDER_KEY)
    if (raw === 'none' || raw === 'cosyvoice' || raw === 'gptsovits') return raw
  } catch { /* ignore */ }
  return 'none'  // 默认不使用 TTS
}

/** 设置当前 TTS 提供者 */
export function setTtsProvider(provider: TtsProvider) {
  localStorage.setItem(PROVIDER_KEY, provider)
  log.debug('TTS 提供者已切换: %s', provider)
}
