/**
 * TTS 模块 - 统一导出
 */
export { loadCosyVoiceConfig, saveCosyVoiceConfig, isCosyVoiceConfigValid, getWsUrl, getHttpUrl, REGIONS, MODELS, DEFAULT_COSYVOICE_CONFIG } from './config'
export { fetchVoiceList } from './api'
export { speakText, cancelSpeak, isSpeaking, isTtsEnabled, setTtsEnabled } from './speak'
export type { CosyVoiceConfig, CosyVoiceModel, VoiceInfo, CosyVoiceRegion } from './types'
