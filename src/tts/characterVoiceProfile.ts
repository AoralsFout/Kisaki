import { DEFAULT_VOICE_LANGUAGE } from '../constants'
import { useCharacterStore } from '../stores/character'

export interface GptSoVitsCharacterParams {
  refAudioPath: string
  promptText: string
  promptLang: string
  textLang: string
}

/** 读取当前角色的 GPT-SoVITS 语音参数；没有活动 Store 时回退到默认值。 */
export async function loadGptSoVitsCharacterParams(): Promise<GptSoVitsCharacterParams> {
  try {
    const data = useCharacterStore().data
    if (data) {
      return {
        refAudioPath: data.gptsovitsRefAudio || '',
        promptText: data.gptsovitsPromptText || '',
        promptLang: data.gptsovitsPromptLang || '',
        textLang: data.voiceLanguage || DEFAULT_VOICE_LANGUAGE,
      }
    }
  } catch {
    // 在独立的 provider 测试与浏览器预览中，Pinia 可能尚未装配。
  }
  return { refAudioPath: '', promptText: '', promptLang: '', textLang: DEFAULT_VOICE_LANGUAGE }
}
