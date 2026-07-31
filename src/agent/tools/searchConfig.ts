/**
 * 联网搜索配置管理（localStorage）
 *
 * 与 AI / TTS 配置一致：API Key 经 utils/crypto 加密后存盘，
 * 解密结果仅缓存在内存，跨窗口通过 storage 事件失效缓存。
 */
import { createLogger } from '../../utils/logger'
import { STORAGE_SEARCH_CONFIG } from '../../constants'
import { encrypt, resolveStoredSecret } from '../../utils/crypto'

const log = createLogger('SearchConfig')
const STORAGE_KEY = STORAGE_SEARCH_CONFIG

/** 支持的搜索提供方 */
export type SearchProvider = 'tavily' | 'brave' | 'searxng'

/** 联网搜索配置 */
export interface SearchConfig {
  /** 提供方 */
  provider: SearchProvider
  /** API Key（searxng 不需要） */
  apiKey: string
  /** 自建实例地址（仅 searxng 使用，如 http://127.0.0.1:8080） */
  baseURL: string
  /** 是否启用联网搜索（关闭时 web_search 工具直接返回未启用提示） */
  enabled: boolean
}

/** 默认配置 */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'tavily',
  apiKey: '',
  baseURL: '',
  enabled: false,
}

/** 提供方展示信息（供设置 UI 使用） */
export const SEARCH_PROVIDERS: { value: SearchProvider; label: string; icon: string; needsKey: boolean; needsBaseURL: boolean }[] = [
  { value: 'tavily', label: 'Tavily', icon: 'fa-bolt', needsKey: true, needsBaseURL: false },
  { value: 'brave', label: 'Brave Search', icon: 'fa-shield-halved', needsKey: true, needsBaseURL: false },
  { value: 'searxng', label: 'SearXNG（自建）', icon: 'fa-server', needsKey: false, needsBaseURL: true },
]

/** 解密后的 API Key 缓存（避免每次搜索都重新解密） */
let _decryptedApiKeyCache: string | null = null

/** 设置解密缓存 */
export function setDecryptedApiKeyCache(key: string) {
  _decryptedApiKeyCache = key
}

export function loadSearchConfig(): SearchConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = { ...DEFAULT_SEARCH_CONFIG, ...JSON.parse(raw) } as SearchConfig
      if (_decryptedApiKeyCache) parsed.apiKey = _decryptedApiKeyCache
      return parsed
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SEARCH_CONFIG }
}

export function saveSearchConfig(config: SearchConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  log.debug('搜索配置已保存 (provider: %s, enabled: %s)', config.provider, config.enabled)
}

/** 配置是否可用：已启用 且 (searxng 有 baseURL / 其它有 apiKey) */
export function isSearchConfigValid(config: SearchConfig): boolean {
  if (!config.enabled) return false
  if (config.provider === 'searxng') return Boolean(config.baseURL)
  return Boolean(config.apiKey)
}

/** 保存配置并加密 API Key */
export async function saveSearchConfigSecure(config: SearchConfig) {
  if (config.apiKey) {
    setDecryptedApiKeyCache(config.apiKey)
    const encrypted = await encrypt(config.apiKey)
    saveSearchConfig({ ...config, apiKey: encrypted })
  } else {
    saveSearchConfig(config)
  }
}

/** 加载配置并解密 API Key，自动迁移旧明文 */
export async function loadSearchConfigSecure(): Promise<SearchConfig> {
  const config = loadSearchConfig()
  if (_decryptedApiKeyCache) return { ...config, apiKey: _decryptedApiKeyCache }

  if (!config.apiKey) return config

  const resolved = await resolveStoredSecret(
    config.apiKey,
    (k) => k.startsWith('tvly-') || k.length <= 20,
  )
  if (resolved.key === null) {
    log.error('搜索 API Key 解密失败，已清除失效配置，请重新填写')
    const cleaned = { ...config, apiKey: '' }
    saveSearchConfig(cleaned)
    return cleaned
  }
  setDecryptedApiKeyCache(resolved.key)
  if (resolved.needsResave) {
    const encryptedKey = await encrypt(resolved.key)
    saveSearchConfig({ ...config, apiKey: encryptedKey })
  }
  return { ...config, apiKey: resolved.key }
}

// 跨窗口配置同步：设置窗口保存后，其它窗口失效解密缓存并重新解密。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    _decryptedApiKeyCache = null
    loadSearchConfigSecure().catch(() => { /* 静默：下次加载会重试 */ })
  })
}
