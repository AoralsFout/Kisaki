/**
 * CosyVoice & GPT-SoVITS 配置管理（localStorage）
 */
import type { CosyVoiceConfig, CosyVoiceModel, CosyVoiceRegion, GptSoVitsConfig, TtsProvider } from './types'
import { createLogger } from '../utils/logger'
import { STORAGE_COSYVOICE_CONFIG, STORAGE_GPTSOVITS_CONFIG, STORAGE_TTS_PROVIDER } from '../constants'
import { SecretBackedSettings } from '../application/settings/secretBackedSettings'
import { localSettingsStore } from '../infrastructure/settings/localSettingsStore'
import { secretStoreGateway } from '../utils/secretStore'

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

const cosyVoiceSettings = new SecretBackedSettings<CosyVoiceConfig>(localSettingsStore, secretStoreGateway, {
  storageKey: STORAGE_KEY,
  defaults: DEFAULT_COSYVOICE_CONFIG,
  secretKind: 'cosyvoice_api_key',
  looksPlaintext: key => key.startsWith('sk-') || key.length <= 20,
  telemetry: {
    secretMigrated: storage => log.debug('ttsconfig.cosyvoice_settings.debug', 'CosyVoice API Key 已迁移到更安全的存储', { storage }),
    secretUnavailable: reason => log.error(
      'ttsconfig.load_cosy_voice_config_secure.error',
      reason === 'transient'
        ? 'CosyVoice API Key 读取失败（瞬时），保留配置待重试'
        : 'CosyVoice API Key 无法读取（密钥链条目丢失或本地密文损坏），请重新配置',
      new Error(reason),
      { reason },
    ),
  },
})

export function loadCosyVoiceConfig(): CosyVoiceConfig { return cosyVoiceSettings.load() }

export function saveCosyVoiceConfig(config: CosyVoiceConfig): void {
  cosyVoiceSettings.save(config)
  log.debug("ttsconfig.save_cosy_voice_config.debug", `CosyVoice 配置已保存 (模型: ${config.model}, 地域: ${config.region})`, { config_model: config.model, config_region: config.region })
}

export function isCosyVoiceConfigValid(config: CosyVoiceConfig): boolean {
  return Boolean(config.apiKey)
}

/** 保存配置并加密 API Key */
export function saveCosyVoiceConfigSecure(config: CosyVoiceConfig): Promise<void> {
  return cosyVoiceSettings.saveSecure(config)
}

/** 加载配置并解密 API Key，自动迁移旧明文 */
export function loadCosyVoiceConfigSecure(): Promise<CosyVoiceConfig> {
  return cosyVoiceSettings.loadSecure()
}

/** 获取当前配置的 WebSocket URL */
export function getWsUrl(config: CosyVoiceConfig): string {
  const region = REGIONS[config.region]
  if (!region) return REGIONS.beijing.wsUrl
  if (config.region === 'singapore' && (config.workspaceId || region.workspaceId)) {
    return region.wsUrl.replace('{WorkspaceId}', config.workspaceId || region.workspaceId || '')
  }
  return region.wsUrl
}

/** 获取当前配置的 HTTP API URL */
export function getHttpUrl(config: CosyVoiceConfig): string {
  const region = REGIONS[config.region]
  if (!region) return REGIONS.beijing.httpUrl
  if (config.region === 'singapore' && (config.workspaceId || region.workspaceId)) {
    return region.httpUrl.replace('{WorkspaceId}', config.workspaceId || region.workspaceId || '')
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
  const raw = localSettingsStore.read(GPTSOVITS_KEY)
  if (raw) {
    try {
      return { ...DEFAULT_GPTSOVITS_CONFIG, ...JSON.parse(raw) } as GptSoVitsConfig
    } catch { /* 损坏的配置按默认值处理 */ }
  }
  return { ...DEFAULT_GPTSOVITS_CONFIG }
}

export function saveGptSoVitsConfig(config: GptSoVitsConfig) {
  localSettingsStore.write(GPTSOVITS_KEY, JSON.stringify(config))
  log.debug("ttsconfig.save_gpt_so_vits_config.debug", 'GPT-SoVITS 配置已保存', { has_api_url: Boolean(config.apiUrl) })
  log.sensitiveDebug("ttsconfig.endpoint_sensitive.debug", 'GPT-SoVITS 服务地址', { api_url: config.apiUrl })
}

export function isGptSoVitsConfigValid(config: GptSoVitsConfig): boolean {
  return Boolean(config.apiUrl)
}

/** 获取当前 TTS 提供者 */
export function getTtsProvider(): TtsProvider {
  const raw = localSettingsStore.read(PROVIDER_KEY)
  if (raw === 'none' || raw === 'cosyvoice' || raw === 'gptsovits') return raw
  return 'none'  // 默认不使用 TTS
}

/** 设置当前 TTS 提供者 */
export function setTtsProvider(provider: TtsProvider) {
  localSettingsStore.write(PROVIDER_KEY, provider)
  log.debug("ttsconfig.set_tts_provider.debug", `TTS 提供者已切换: ${provider}`, { provider: provider })
}
