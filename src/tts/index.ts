/**
 * TTS 模块 - 统一导出
 */
export { loadCosyVoiceConfig, saveCosyVoiceConfig, loadCosyVoiceConfigSecure, saveCosyVoiceConfigSecure, isCosyVoiceConfigValid, getWsUrl, getHttpUrl, REGIONS, MODELS, DEFAULT_COSYVOICE_CONFIG } from './config'
export { fetchVoiceList } from './api'
export { speakText, speakTextStreaming, cancelSpeak, isSpeaking, isTtsEnabled, setTtsEnabled, setVoicePlayer } from './speak'
export type { VoicePlayer } from './speak'
export type { CosyVoiceConfig, CosyVoiceModel, VoiceInfo, CosyVoiceRegion } from './types'
