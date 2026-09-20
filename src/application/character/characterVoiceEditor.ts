import { fetchVoiceList } from '../../tts/api'
import { loadCosyVoiceConfigSecure, isCosyVoiceConfigValid } from '../../tts/config'
import { ttsPlaybackOrchestrator } from '../../tts/orchestrator'
import type { TtsPlaybackResult } from '../tts/ttsPlaybackOrchestrator'
import type { TtsProvider, VoiceInfo } from '../../tts/types'

/** 角色音色字段的受控投影。provider 属于当前 TTS 配置，不写入角色文件。 */
export interface CharacterVoiceDraft {
  voice: string
  voiceModel: string
  voiceLanguage: string
  textLanguage: string
  gptsovitsRefAudio: string
  gptsovitsPromptText: string
  gptsovitsPromptLang: string
}

export type CharacterVoiceDraftField = keyof CharacterVoiceDraft

export interface CharacterVoicePreviewRequest {
  requestId: string
  provider: Exclude<TtsProvider, 'none'>
  text: string
  voiceId: string
  voiceModel: string
  voiceLanguage: string
  textLanguage: string
  gptsovitsRefAudio: string
  gptsovitsPromptText: string
  gptsovitsPromptLang: string
}

export interface CharacterVoiceEditorPorts {
  /** 仅 CosyVoice 需要从服务端读取音色能力。 */
  loadVoices: () => Promise<VoiceInfo[]>
  preview: (request: CharacterVoicePreviewRequest) => Promise<TtsPlaybackResult | void>
  cancelPreview: (reason?: string, resetDedupe?: boolean) => void
  /** 文件选择仍由端口提供，组件不直接依赖 Tauri dialog。 */
  pickReferenceAudio?: () => Promise<string | null | undefined>
}

/**
 * 生产环境默认端口。组件本身不依赖 Tauri/Pinia，测试和未来装配可替换全部端口。
 */
export const defaultCharacterVoiceEditorPorts: CharacterVoiceEditorPorts = {
  async loadVoices() {
    const config = await loadCosyVoiceConfigSecure()
    if (!isCosyVoiceConfigValid(config)) throw new Error('请先配置 CosyVoice API Key')
    return fetchVoiceList({ apiKey: config.apiKey })
  },
  preview(request) {
    return ttsPlaybackOrchestrator.play({
      requestId: request.requestId,
      text: request.text,
      voiceId: request.voiceId,
      voiceLanguage: request.voiceLanguage,
      deduplicate: false,
    })
  },
  cancelPreview(reason = 'preview-cancelled', resetDedupe = true) {
    ttsPlaybackOrchestrator.cancel(reason, resetDedupe)
  },
}

export function emptyCharacterVoiceDraft(): CharacterVoiceDraft {
  return {
    voice: '',
    voiceModel: '',
    voiceLanguage: 'ja-JP',
    textLanguage: 'zh-CN',
    gptsovitsRefAudio: '',
    gptsovitsPromptText: '',
    gptsovitsPromptLang: 'ja-JP',
  }
}
