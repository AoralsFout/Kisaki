/**
 * CosyVoice HTTP API 调用
 *
 * 通过 DashScope HTTP API 管理音色（查询列表等）。
 */
import { loadCosyVoiceConfig, getHttpUrl } from './config'
import type { VoiceInfo, CosyVoiceConfig } from './types'
import { createLogger } from '../utils/logger'

const log = createLogger('TTSApi')

/** 从服务端查询用户创建的自定义音色列表 */
export async function fetchVoiceList(overrides?: Partial<CosyVoiceConfig>): Promise<VoiceInfo[]> {
  const config = { ...loadCosyVoiceConfig(), ...overrides }
  // 如果调用方传入了解密后的 apiKey，优先使用
  const apiKey = overrides?.apiKey ?? config.apiKey
  if (!apiKey) {
    log.warn("ttsapi.fetch_voice_list.warn", "fetchVoiceList: API Key 未配置")
    throw new Error('请先配置 CosyVoice API Key')
  }

  const url = getHttpUrl(config)
  if (url.includes('{WorkspaceId}')) {
    log.warn("ttsapi.fetch_voice_list.warn", "fetchVoiceList: 新加坡地域须填写 WorkspaceId")
    throw new Error('新加坡地域需要填写 WorkspaceId')
  }

  log.debug("ttsapi.fetch_voice_list.debug", "获取音色列表...")

  const payload = {
    model: 'voice-enrollment',
    input: {
      action: 'list_voice',
      page_size: 100,
      page_index: 0,
    },
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`查询音色列表失败 (${response.status}): ${errBody.slice(0, 200)}`)
  }

  const data = await response.json()
  const rawVoices: Record<string, any>[] = data?.output?.voice_list ?? []

  const voices = rawVoices
    .filter((v: any) => v.status === 'OK')
    .map((v: any) => ({
      voiceId: v.voice_id ?? '',
      gmtCreate: v.gmt_create ?? '',
      gmtModified: v.gmt_modified ?? '',
      status: v.status ?? '',
      targetModel: v.target_model ?? '',
      prefix: v.prefix ?? '',
    }))

  log.info("ttsapi.fetch_voice_list.info", `获取到 ${voices.length} 个可用音色`, { voices_length: voices.length })
  return voices
}

/** 测试 API Key 是否有效 */
export async function testApiKey(): Promise<boolean> {
  try {
    const list = await fetchVoiceList()
    log.debug("ttsapi.test_api_key.debug", `API Key 测试通过（${list.length} 个音色）`, { list_length: list.length })
    return true
  } catch {
    log.warn("ttsapi.test_api_key.warn", "API Key 测试失败")
    return false
  }
}
