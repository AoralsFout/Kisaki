/**
 * CosyVoice TTS 播报服务
 *
 * 调用 Rust 后端的 WebSocket TTS 命令合成语音，并通过 HTMLAudioElement 播放。
 */
import { invoke } from '@tauri-apps/api/core'
import { loadCosyVoiceConfig, getWsUrl } from './config'

/** TTS 存储 key */
const ENABLED_KEY = 'deskpet-tts-enabled'

/** 语音播报是否开启 */
export function isTtsEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

/** 设置语音播报开关 */
export function setTtsEnabled(enabled: boolean) {
  localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false')
}

/** 当前控制对象 */
let currentController: AbortController | null = null

/** 合成并播报文本 */
export async function speakText(text: string, voiceId: string): Promise<void> {
  // 如果播报已关闭，跳过
  if (!isTtsEnabled()) return

  // 取消当前正在播报的语音
  cancelSpeak()

  const controller = new AbortController()
  currentController = controller

  const cvConfig = loadCosyVoiceConfig()
  if (!cvConfig.apiKey || !voiceId) return

  const wsUrl = getWsUrl(cvConfig)
  if (wsUrl.includes('{WorkspaceId}')) return // 新加坡地域未配置

  try {
    const result = await invoke<TtsCommandResult>('cosyvoice_tts', {
      apiKey: cvConfig.apiKey,
      model: cvConfig.model,
      voice: voiceId,
      text: text,
      wsUrl: wsUrl,
    })

    // 检查是否已被取消
    if (controller.signal.aborted) return

    // 播放音频
    await playAudio(result.audio_base64, result.format, controller.signal)
  } catch (err) {
    console.warn('[TTS] 播报失败:', err)
  } finally {
    if (currentController === controller) {
      currentController = null
    }
  }
}

/** 取消当前播报 */
export function cancelSpeak() {
  if (currentController) {
    currentController.abort()
    currentController = null
  }
}

/** 检查是否正在播报 */
export function isSpeaking(): boolean {
  return currentController !== null
}

interface TtsCommandResult {
  audio_base64: string
  format: string
}

/** 通过 HTMLAudioElement 播放 base64 音频 */
function playAudio(base64Data: string, format: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
      const byteChars = atob(base64Data)
      const byteArrays: Uint8Array[] = []

      for (let offset = 0; offset < byteChars.length; offset += 512) {
        const slice = byteChars.slice(offset, offset + 512)
        const bytes = new Uint8Array(slice.length)
        for (let i = 0; i < slice.length; i++) {
          bytes[i] = slice.charCodeAt(i)
        }
        byteArrays.push(bytes)
      }

      const blob = new Blob(byteArrays, { type: mimeType })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)

      audio.onended = () => {
        URL.revokeObjectURL(url)
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('音频播放失败'))
      }

      // 监听取消信号
      if (signal.aborted) {
        audio.pause()
        audio.src = ''
        URL.revokeObjectURL(url)
        resolve()
        return
      }
      signal.addEventListener('abort', () => {
        audio.pause()
        audio.src = ''
        URL.revokeObjectURL(url)
        resolve()
      })

      audio.play().catch((err) => {
        URL.revokeObjectURL(url)
        reject(err)
      })
    } catch (err) {
      reject(err)
    }
  })
}
