<script setup lang="ts">
/**
 * 语音合成 (CosyVoice) 设置 - 开关、配置、音色列表、显示语言、打字速度
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  loadCosyVoiceConfigSecure, saveCosyVoiceConfigSecure,
  REGIONS, MODELS, DEFAULT_COSYVOICE_CONFIG,
  isTtsEnabled, setTtsEnabled,
} from '../../tts'
import { fetchVoiceList } from '../../tts/api'
import type { CosyVoiceConfig, VoiceInfo } from '../../tts/types'
import { getDisplayLanguage, setDisplayLanguage, SUPPORTED_LANGUAGES } from '../../stores/language'
import { getTypingSpeed, setTypingSpeed } from '../../stores/language'

const { t } = useI18n()

const cvConfig = ref<CosyVoiceConfig>({ ...DEFAULT_COSYVOICE_CONFIG })
const cvSaved = ref(false)
const voices = ref<VoiceInfo[]>([])
const loadingVoices = ref(false)
const voiceError = ref('')
const ttsEnabled = ref(isTtsEnabled())
const displayLang = ref(getDisplayLanguage())
const typingSpeed = ref(getTypingSpeed())

onMounted(async () => {
  cvConfig.value = { ...await loadCosyVoiceConfigSecure() }
})

function onTypingSpeedInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  typingSpeed.value = val
  setTypingSpeed(val)
}

async function handleCvSave() {
  await saveCosyVoiceConfigSecure(cvConfig.value)
  cvSaved.value = true
  voiceError.value = ''
  setTimeout(() => { cvSaved.value = false }, 1500)
}

async function handleFetchVoices() {
  loadingVoices.value = true
  voiceError.value = ''
  voices.value = []
  try {
    // 先保存当前配置
    await saveCosyVoiceConfigSecure(cvConfig.value)
    const list = await fetchVoiceList({ apiKey: cvConfig.value.apiKey })
    voices.value = list
    if (list.length === 0) {
      voiceError.value = t('settings.tts.noVoices')
    }
  } catch (e) {
    voiceError.value = (e as Error).message
  } finally {
    loadingVoices.value = false
  }
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-microphone"></i> {{ t('settings.tts.title') }}</h2>
    <p class="section-desc">{{ t('settings.tts.desc') }}</p>

    <!-- TTS 总开关 -->
    <div class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.tts.enableTitle') }}</span>
          <span class="toggle-label-desc">{{ t('settings.tts.enableDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: ttsEnabled }]"
          @click="ttsEnabled = !ttsEnabled; setTtsEnabled(ttsEnabled)" role="switch" :aria-checked="ttsEnabled">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <hr class="section-divider" />

    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.apiKeyLabel') }}</label>
      <input v-model="cvConfig.apiKey" class="form-input" type="password" placeholder="sk-..." />
      <p class="form-hint">{{ t('settings.tts.apiKeyHint') }}</p>
    </div>

    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.modelLabel') }}</label>
      <select v-model="cvConfig.model" class="form-select">
        <option v-for="m in MODELS" :key="m.value" :value="m.value">{{ m.label }}</option>
      </select>
      <p class="form-hint">{{ t('settings.tts.modelHint') }}</p>
    </div>

    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.region') }}</label>
      <select v-model="cvConfig.region" class="form-select">
        <option v-for="(r, k) in REGIONS" :key="k" :value="k">{{ r.label }}</option>
      </select>
    </div>

    <div v-if="cvConfig.region === 'singapore'" class="form-group">
      <label class="form-label">{{ t('settings.tts.workspaceId') }}</label>
      <input v-model="REGIONS.singapore.workspaceId" class="form-input" :placeholder="t('settings.tts.workspaceIdPlaceholder')" />
      <p class="form-hint">{{ t('settings.tts.workspaceIdHint') }}</p>
    </div>

    <div class="form-actions">
      <button class="btn-save" @click="handleCvSave">
        {{ cvSaved ? t('common.saved') : t('settings.tts.saveConfig') }}
      </button>
    </div>

    <hr class="section-divider" />

    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.myVoices') }}</label>
      <button class="btn-secondary" :disabled="loadingVoices || !cvConfig.apiKey" @click="handleFetchVoices">
        <i class="fas fa-sync" :class="{ spinning: loadingVoices }"></i>
        {{ loadingVoices ? t('settings.tts.fetching') : t('settings.tts.fetchVoices') }}
      </button>

      <div v-if="voiceError" class="voice-error">{{ voiceError }}</div>

      <div v-if="voices.length > 0" class="voice-list">
        <div v-for="v in voices" :key="v.voiceId" class="voice-item">
          <div class="voice-item-icon"><i class="fas fa-user-mic"></i></div>
          <div class="voice-item-info">
            <div class="voice-item-id">{{ v.voiceId }}</div>
            <div class="voice-item-meta">{{ t('settings.tts.voiceMeta', { date: v.gmtCreate, status: v.status }) }}</div>
          </div>
        </div>
      </div>
    </div>

    <hr class="section-divider" />

    <!-- 用户显示语言偏好 -->
    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.displayLang') }}</label>
      <select v-model="displayLang" class="form-select" @change="setDisplayLanguage(displayLang)">
        <option v-for="l in SUPPORTED_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
      </select>
      <p class="form-hint">{{ t('settings.tts.displayLangHint') }}</p>
    </div>

    <!-- 打字机速度 -->
    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.typingSpeed') }}</label>
      <div class="speed-slider-row">
        <input type="range" min="10" max="200" step="5" :value="typingSpeed" @input="onTypingSpeedInput"
          class="speed-slider" />
        <span class="speed-value">{{ typingSpeed }}ms</span>
        <span class="speed-tag"
          :class="{ fast: typingSpeed <= 20, medium: typingSpeed > 20 && typingSpeed <= 60, slow: typingSpeed > 60 }">
          {{ typingSpeed <= 20 ? t('settings.tts.speedFast') : typingSpeed <= 60 ? t('settings.tts.speedMedium') : t('settings.tts.speedSlow') }}
        </span>
      </div>
      <p class="form-hint">{{ t('settings.tts.typingSpeedHint') }}</p>
    </div>
  </div>
</template>
