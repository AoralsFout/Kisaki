import { DEFAULT_VOICE_LANGUAGE } from '../constants'

export interface GptSoVitsCharacterParams {
  refAudioPath: string
  promptText: string
  promptLang: string
  textLang: string
}

/** Transitional adapter: resolve character-scoped voice data outside providers and TtsEngine. */
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
    // Pinia is unavailable in isolated provider tests and browser previews.
  }
  return { refAudioPath: '', promptText: '', promptLang: '', textLang: DEFAULT_VOICE_LANGUAGE }
}
