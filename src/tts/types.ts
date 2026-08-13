/**
 * CosyVoice / DashScope TTS 相关类型定义
 */

/** CosyVoice 配置 */
export interface CosyVoiceConfig {
  /** DashScope API Key */
  apiKey: string
  /** 语音合成模型 */
  model: CosyVoiceModel
  /** 地域 key（对应 REGIONS 的 key） */
  region: string
  /** Key 存储方式标记：'keychain' 时明文在系统密钥链，apiKey 字段为空 */
  keyStorage?: 'keychain'
}

/** 支持的 CosyVoice 模型 */
export type CosyVoiceModel =
  | 'cosyvoice-v3.5-plus'
  | 'cosyvoice-v3.5-flash'
  | 'cosyvoice-v3-plus'
  | 'cosyvoice-v3-flash'
  | 'cosyvoice-v2'
  | 'cosyvoice-v1'

/** 地域 */
export interface CosyVoiceRegion {
  label: string
  /** 语音合成 WebSocket URL */
  wsUrl: string
  /** HTTP API URL（声音复刻管理） */
  httpUrl: string
  /** WorkspaceId（新加坡地域需要） */
  workspaceId?: string
}

/** TTS 提供者 */
export type TtsProvider = 'none' | 'cosyvoice' | 'gptsovits'

/** GPT-SoVITS 配置 */
export interface GptSoVitsConfig {
  /** API 服务地址（默认 http://127.0.0.1:9880） */
  apiUrl: string
  /** Top-k 采样 */
  topK: number
  /** Top-p 采样 */
  topP: number
  /** 采样温度 */
  temperature: number
  /** 语速 */
  speedFactor: number
}

/** 音色信息（从服务端查询返回） */
export interface VoiceInfo {
  /** 音色 ID */
  voiceId: string
  /** 创建时间 */
  gmtCreate: string
  /** 最后修改时间 */
  gmtModified: string
  /** 状态 */
  status: string
  /** 绑定的模型 */
  targetModel?: string
  /** 前缀/名称 */
  prefix?: string
}

/** 查询音色列表返回值 */
export interface VoiceListResponse {
  output: {
    voice_list: VoiceInfo[]
  }
  usage: {
    count: number
  }
  request_id: string
}
