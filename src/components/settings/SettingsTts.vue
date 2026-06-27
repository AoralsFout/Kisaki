<script setup lang="ts">
/**
 * 语音合成设置 - TTS 引擎选择、配置、显示语言、打字速度
 *
 * 支持两种引擎：
 *   - 阿里云 CosyVoice（云端 WebSocket）
 *   - 本地 GPT-SoVITS（本地 HTTP API，参考音频在角色管理器中设置）
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  loadCosyVoiceConfigSecure, saveCosyVoiceConfigSecure,
  REGIONS, MODELS, DEFAULT_COSYVOICE_CONFIG,
  loadGptSoVitsConfig, saveGptSoVitsConfig, DEFAULT_GPTSOVITS_CONFIG,
  getTtsProvider, setTtsProvider,
  isTtsEnabled, setTtsEnabled,
} from '../../tts'
import { fetchVoiceList } from '../../tts/api'
import type { CosyVoiceConfig, GptSoVitsConfig, VoiceInfo, TtsProvider } from '../../tts/types'
import { getDisplayLanguage, setDisplayLanguage, SUPPORTED_LANGUAGES } from '../../stores/language'
import { getTypingSpeed, setTypingSpeed } from '../../stores/language'

const { t } = useI18n()

const provider = ref<TtsProvider>(getTtsProvider())

// CosyVoice state
const cvConfig = ref<CosyVoiceConfig>({ ...DEFAULT_COSYVOICE_CONFIG })
const cvSaved = ref(false)
const voices = ref<VoiceInfo[]>([])
const loadingVoices = ref(false)
const voiceError = ref('')

// GPT-SoVITS state
const gsConfig = ref<GptSoVitsConfig>({ ...DEFAULT_GPTSOVITS_CONFIG })
const gsSaved = ref(false)
const showAdvanced = ref(false)

const ttsEnabled = ref(isTtsEnabled())
const displayLang = ref(getDisplayLanguage())
const typingSpeed = ref(getTypingSpeed())

onMounted(async () => {
  cvConfig.value = { ...await loadCosyVoiceConfigSecure() }
  gsConfig.value = { ...loadGptSoVitsConfig() }
})

function onTypingSpeedInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  typingSpeed.value = val
  setTypingSpeed(val)
}

// ── Provider 切换 ──

function handleProviderChange(newProvider: TtsProvider) {
  provider.value = newProvider
  setTtsProvider(newProvider)
}

// ── CosyVoice ──

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

// ── GPT-SoVITS ──

function handleGsSave() {
  saveGptSoVitsConfig(gsConfig.value)
  gsSaved.value = true
  setTimeout(() => { gsSaved.value = false }, 1500)
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

    <!-- TTS 引擎选择 -->
    <div class="form-group">
      <label class="form-label">{{ t('settings.tts.provider') }}</label>
      <div class="provider-tabs">
        <button :class="['provider-tab', { active: provider === 'none' }]"
          @click="handleProviderChange('none')">
          <i class="fas fa-ban"></i>
          {{ t('settings.tts.providerNone') }}
        </button>
        <button :class="['provider-tab', { active: provider === 'cosyvoice' }]"
          @click="handleProviderChange('cosyvoice')">
          <i class="fas fa-cloud"></i>
          {{ t('settings.tts.providerCosyVoice') }}
        </button>
        <button :class="['provider-tab', { active: provider === 'gptsovits' }]"
          @click="handleProviderChange('gptsovits')">
          <i class="fas fa-server"></i>
          {{ t('settings.tts.providerGptSoVits') }}
        </button>
      </div>
      <p class="form-hint">{{ t('settings.tts.providerHint') }}</p>
      <p v-if="provider === 'none'" class="form-hint provider-none-hint">
        <i class="fas fa-info-circle"></i> {{ t('settings.tts.providerNoneHint') }}
      </p>
    </div>

    <!-- ═══════════════ CosyVoice 配置 ═══════════════ -->
    <template v-if="provider === 'cosyvoice'">
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
    </template>

    <!-- ═══════════════ GPT-SoVITS 配置 ═══════════════ -->
    <template v-if="provider === 'gptsovits'">
      <hr class="section-divider" />

      <div class="form-group">
        <label class="form-label">{{ t('settings.tts.gptsovitsApiUrl') }}</label>
        <input v-model="gsConfig.apiUrl" class="form-input" type="url" placeholder="http://127.0.0.1:9880" />
        <p class="form-hint">{{ t('settings.tts.gptsovitsApiUrlHint') }}</p>
      </div>

      <div class="form-group">
        <p class="form-hint ref-audio-hint">
          <i class="fas fa-info-circle"></i>
          {{ t('settings.tts.gptsovitsRefAudioNote') }}
        </p>
      </div>

      <!-- 高级参数 -->
      <div class="form-group">
        <button class="btn-text" @click="showAdvanced = !showAdvanced">
          <i class="fas" :class="showAdvanced ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
          {{ t('settings.tts.gptsovitsAdvanced') }}
        </button>
      </div>

      <template v-if="showAdvanced">
        <div class="form-row">
          <div class="form-group form-group-third">
            <label class="form-label">{{ t('settings.tts.gptsovitsTopK') }}</label>
            <input v-model.number="gsConfig.topK" class="form-input" type="number" min="1" max="100" />
          </div>
          <div class="form-group form-group-third">
            <label class="form-label">{{ t('settings.tts.gptsovitsTopP') }}</label>
            <input v-model.number="gsConfig.topP" class="form-input" type="number" min="0" max="1" step="0.05" />
          </div>
          <div class="form-group form-group-third">
            <label class="form-label">{{ t('settings.tts.gptsovitsTemperature') }}</label>
            <input v-model.number="gsConfig.temperature" class="form-input" type="number" min="0" max="2" step="0.1" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group form-group-half">
            <label class="form-label">{{ t('settings.tts.gptsovitsSpeed') }}</label>
            <input v-model.number="gsConfig.speedFactor" class="form-input" type="number" min="0.5" max="2.0" step="0.1" />
          </div>
        </div>
      </template>

      <div class="form-actions">
        <button class="btn-save" @click="handleGsSave">
          {{ gsSaved ? t('common.saved') : t('settings.tts.saveConfig') }}
        </button>
      </div>
    </template>

    <hr class="section-divider" />

    <!-- ═══════════════ 共用设置 ═══════════════ -->

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

<style scoped>
/* ── Provider none hint ── */
.provider-none-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: #1a1a34;
  border-radius: 6px;
  border: 1px solid #3a3a5c;
  color: #a0a0c0;
  font-size: 12px;
  margin-top: 8px;
}

/* ── Form row ── */
.form-row {
  display: flex;
  gap: 12px;
  margin-bottom: 4px;
}

.form-group-half {
  flex: 1;
  min-width: 0;
}

.form-group-third {
  flex: 1;
  min-width: 0;
}

/* ── Text button ── */
.btn-text {
  background: none;
  border: none;
  color: #7c5cfc;
  cursor: pointer;
  padding: 4px 0;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-text:hover {
  color: #9c7cff;
}

/* ── Reference audio hint ── */
.ref-audio-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: #1a1a34;
  border-radius: 6px;
  border: 1px solid #3a3a5c;
  color: #a0a0c0;
  font-size: 12px;
}
</style>
