/**
 * 联网搜索配置管理（localStorage）
 *
 * 与 AI / TTS 配置一致：API Key 经 utils/crypto 加密后存盘，
 * 解密结果仅缓存在内存，跨窗口通过 storage 事件失效缓存。
 */
import { createLogger } from '../../utils/logger'
import { STORAGE_SEARCH_CONFIG } from '../../constants'
import { SecretBackedSettings } from '../../application/settings/secretBackedSettings'
import { localSettingsStore } from '../../infrastructure/settings/localSettingsStore'
import { secretStoreGateway } from '../../utils/secretStore'

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
  /** Key 存储方式标记：'keychain' 时明文在系统密钥链，apiKey 字段为空 */
  keyStorage?: 'keychain'
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

const searchSettings = new SecretBackedSettings<SearchConfig>(localSettingsStore, secretStoreGateway, {
  storageKey: STORAGE_KEY,
  defaults: DEFAULT_SEARCH_CONFIG,
  secretKind: 'search_api_key',
  looksPlaintext: key => key.startsWith('tvly-') || key.length <= 20,
  telemetry: {
    secretMigrated: storage => log.debug('search_config.settings.debug', '搜索 API Key 已迁移到更安全的存储', { storage }),
    secretUnavailable: reason => log.error(
      'search_config.load_search_config_secure.error',
      reason === 'transient'
        ? '搜索 API Key 读取失败（瞬时），保留配置待重试'
        : '搜索 API Key 无法读取（密钥链条目丢失或本地密文损坏），请重新配置',
      new Error(reason),
      { reason },
    ),
  },
})

export function loadSearchConfig(): SearchConfig { return searchSettings.load() }

export function saveSearchConfig(config: SearchConfig): void {
  searchSettings.save(config)
  log.debug("search_config.save_search_config.debug", `搜索配置已保存 (provider: ${config.provider}, enabled: ${config.enabled})`, { config_provider: config.provider, config_enabled: config.enabled })
}

/** 配置是否可用：已启用 且 (searxng 有 baseURL / 其它有 apiKey) */
export function isSearchConfigValid(config: SearchConfig): boolean {
  if (!config.enabled) return false
  if (config.provider === 'searxng') return Boolean(config.baseURL)
  return Boolean(config.apiKey)
}

/** 保存配置并加密 API Key */
export function saveSearchConfigSecure(config: SearchConfig): Promise<void> {
  return searchSettings.saveSecure(config)
}

/** 加载配置并解密 API Key，自动迁移旧明文 */
export function loadSearchConfigSecure(): Promise<SearchConfig> {
  return searchSettings.loadSecure()
}
