/**
 * CosyVoice 配置管理（localStorage）
 */
import type { CosyVoiceConfig, CosyVoiceModel, CosyVoiceRegion } from './types'

const STORAGE_KEY = 'deskpet-cosyvoice-config'

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

export function loadCosyVoiceConfig(): CosyVoiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_COSYVOICE_CONFIG, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_COSYVOICE_CONFIG }
}

export function saveCosyVoiceConfig(config: CosyVoiceConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export function isCosyVoiceConfigValid(config: CosyVoiceConfig): boolean {
  return Boolean(config.apiKey)
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
