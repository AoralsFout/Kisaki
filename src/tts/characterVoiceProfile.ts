import { DEFAULT_VOICE_LANGUAGE } from '../constants'

export interface GptSoVitsCharacterParams {
  refAudioPath: string
  promptText: string
  promptLang: string
  textLang: string
}

/** 过渡期适配器：在 provider 与 TtsEngine 之外解析角色级语音数据。 */
export async function loadGptSoVitsCharacterParams(): Promise<GptSoVitsCharacterParams> {
  try {
    const { getActivePinia } = await import('pinia')
    const pinia = getActivePinia()
    if (pinia) {
      const { useCharacterStore } = await import('../stores/character')
      const data = useCharacterStore(pinia).data
      if (data) {
        return {
          refAudioPath: data.gptsovitsRefAudio || '',
          promptText: data.gptsovitsPromptText || '',
          promptLang: data.gptsovitsPromptLang || '',
          textLang: data.voiceLanguage || DEFAULT_VOICE_LANGUAGE,
        }
      }
    }
  } catch {
    // 在独立的 provider 测试与浏览器预览中，Pinia 不可用。
  }
  return { refAudioPath: '', promptText: '', promptLang: '', textLang: DEFAULT_VOICE_LANGUAGE }
}
