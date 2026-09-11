/**
 * GPT-SoVITS HTTP API 客户端
 *
 * 通过本地 HTTP API 调用 GPT-SoVITS 进行语音合成。
 * 参考 API: e:\AI\GPT-SoVITS-v2pro-20250604\api_v2.py
 *
 * 支持批处理模式（等待完整音频返回后播放）。
 */
import { invoke } from '@tauri-apps/api/core'
import { loadGptSoVitsConfig } from './config'
import type { GptSoVitsConfig } from './types'
import { createLogger } from '../utils/logger'

const log = createLogger('GptSoVits')

/**
 * GPT-SoVITS 语言代码映射（BCP-47 → GPT-SoVITS 格式）
 * GPT-SoVITS 使用简码如 "ja"、"zh"、"en"，而非 "ja-JP"、"zh-CN" 这类 BCP-47 格式
 */
const LANG_MAP: Record<string, string> = {
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'zh-HK': 'yue',
  'ja-JP': 'ja',
  'en-US': 'en',
  'ko-KR': 'ko',
}

/** 将 BCP-47 语言代码标准化为 GPT-SoVITS 兼容格式 */
function normalizeLang(lang: string): string {
  return LANG_MAP[lang] || lang
}

/** 合成参数（全部由角色配置提供，无全局默认） */
export interface GptSoVitsSynthesizeParams {
  text: string
  /** 参考音频路径（必填） */
  refAudioPath: string
  /** 参考音频转录文本 */
  promptText?: string
  /** 参考音频语言 */
  promptLang?: string
  /** 合成文本语言（必填，来自角色 voiceLanguage） */
  textLang: string
}

/** GPT-SoVITS API 返回的音频数据 */
export interface GptSoVitsResult {
  /** 音频 blob（WAV / OGG / AAC） */
  blob: Blob
  /** 音频格式 */
  format: string
}

/**
 * 使用 GPT-SoVITS 合成语音（批处理模式）
 *
 * @param params 合成参数
 * @param overrides 可选覆盖全局配置（apiUrl, topK, topP, 等）
 * @returns 音频 blob 与格式
 */
export async function synthesizeWithGptSoVits(
  params: GptSoVitsSynthesizeParams,
  overrides?: Partial<GptSoVitsConfig>,
): Promise<GptSoVitsResult> {
  const config = { ...loadGptSoVitsConfig(), ...overrides }

  if (!config.apiUrl) {
    throw new Error('GPT-SoVITS API URL 未配置')
  }
  if (!params.refAudioPath) {
    throw new Error('参考音频路径未配置')
  }

  // 标准化语言代码（GPT-SoVITS 使用简码，如 "ja" 而非 "ja-JP"）
  const textLang = normalizeLang(params.textLang)
  const promptLang = params.promptLang ? normalizeLang(params.promptLang) : undefined

  // 标准化路径（反斜杠 → 正斜杠，避免 URL 编码或解析问题）
  const refAudioPath = params.refAudioPath.replace(/\\/g, '/')

  // 构建请求参数
  const searchParams = new URLSearchParams()
  searchParams.set('text', params.text)
  searchParams.set('text_lang', textLang)
  searchParams.set('ref_audio_path', refAudioPath)
  if (params.promptText) searchParams.set('prompt_text', params.promptText)
  if (promptLang) searchParams.set('prompt_lang', promptLang)
  searchParams.set('media_type', 'wav')
  searchParams.set('streaming_mode', '0')
  searchParams.set('top_k', String(config.topK))
  searchParams.set('top_p', String(config.topP))
  searchParams.set('temperature', String(config.temperature))
  searchParams.set('speed_factor', String(config.speedFactor))

  // 拼装完整 URL
  const baseUrl = config.apiUrl.replace(/\/+$/, '')
  const url = `${baseUrl}/tts?${searchParams.toString()}`

  log.debug("gpt_so_vits.synthesize_with_gpt_so_vits.debug", `GPT-SoVITS 请求: text=${params.text.length}字 lang=${textLang}`, { text_length: params.text.length, text_lang: textLang })
  log.sensitiveDebug("gpt_so_vits.request_sensitive.debug", "GPT-SoVITS 敏感请求参数", { base_url: baseUrl, text: params.text.slice(0, 100), ref_audio_path: refAudioPath })

  // 通过 Rust 后端代理请求（绕过 webview CORS 限制）
  const result = await invoke<{ audio_base64: string; format: string }>('gptsovits_tts', { url })

  const format = result.format
  const mimeTypes: Record<string, string> = {
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    raw: 'audio/L16',
  }
  const mimeType = mimeTypes[format] || 'audio/wav'

  // 将 base64 解码为 blob
  const binaryStr = atob(result.audio_base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
  const blob = new Blob([bytes], { type: mimeType })

  log.info("gpt_so_vits.synthesize_with_gpt_so_vits.info", `GPT-SoVITS 合成完成: ${params.text.length} 字符 → ${blob.size} bytes (${format})`, { params_text: params.text.length, blob_size: blob.size, format: format })

  return { blob, format: mimeType }
}

/**
 * GPT-SoVITS 流式合成 URL 构建（不含 host）
 * 调用方将结果传给 Rust gptsovits_tts_stream 命令
 */
export function buildGptSoVitsStreamUrl(
  text: string,
  refAudioPath: string,
  textLang: string,
  promptText?: string,
  promptLang?: string,
): string {
  const config = loadGptSoVitsConfig()

  const normalizedTextLang = normalizeLang(textLang)
  const normalizedPromptLang = promptLang ? normalizeLang(promptLang) : undefined
  const normalizedPath = refAudioPath.replace(/\\/g, '/')

  const searchParams = new URLSearchParams()
  searchParams.set('text', text)
  searchParams.set('text_lang', normalizedTextLang)
  searchParams.set('ref_audio_path', normalizedPath)
  if (promptText) searchParams.set('prompt_text', promptText)
  if (normalizedPromptLang) searchParams.set('prompt_lang', normalizedPromptLang)
  // 流式固定 wav：服务端首帧返回 44 字节 WAV 头（含真实采样率），其后为裸 PCM。
  // 前端 PcmStreamPlayer 解析头部后按 PCM 连续排程播放（ogg/aac 无法逐帧解码，故不可用于流式）。
  searchParams.set('media_type', 'wav')
  searchParams.set('streaming_mode', '1')
  searchParams.set('top_k', String(config.topK))
  searchParams.set('top_p', String(config.topP))
  searchParams.set('temperature', String(config.temperature))
  searchParams.set('speed_factor', String(config.speedFactor))

  const baseUrl = config.apiUrl.replace(/\/+$/, '')
  return `${baseUrl}/tts?${searchParams.toString()}`
}
