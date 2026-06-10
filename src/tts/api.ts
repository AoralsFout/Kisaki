/**
 * CosyVoice HTTP API 调用
 *
 * 通过 DashScope HTTP API 管理音色（查询列表等）。
 */
import { loadCosyVoiceConfig, getHttpUrl } from './config'
import type { VoiceInfo } from './types'

/** 从服务端查询用户创建的自定义音色列表 */
export async function fetchVoiceList(): Promise<VoiceInfo[]> {
  const config = loadCosyVoiceConfig()
  if (!config.apiKey) {
    throw new Error('请先配置 CosyVoice API Key')
  }

  const url = getHttpUrl(config)
  if (url.includes('{WorkspaceId}')) {
    throw new Error('新加坡地域需要填写 WorkspaceId')
  }

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
      'Authorization': `Bearer ${config.apiKey}`,
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

  // API 返回 snake_case，映射为 camelCase
  return rawVoices
    .filter(v => v.status === 'OK')
    .map(v => ({
      voiceId: v.voice_id ?? '',
      gmtCreate: v.gmt_create ?? '',
      gmtModified: v.gmt_modified ?? '',
      status: v.status ?? '',
      targetModel: v.target_model ?? '',
      prefix: v.prefix ?? '',
    }))
}

/** 测试 API Key 是否有效 */
export async function testApiKey(): Promise<boolean> {
  try {
    await fetchVoiceList()
    return true
  } catch {
    return false
  }
}
