<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LANGUAGES } from '../stores/language'
import type { TtsProvider, VoiceInfo } from '../tts/types'
import {
  defaultCharacterVoiceEditorPorts,
  type CharacterVoiceDraft,
  type CharacterVoiceDraftField,
  type CharacterVoiceEditorPorts,
  type CharacterVoicePreviewRequest,
} from '../application/character/characterVoiceEditor'

const props = withDefaults(defineProps<{
  /** 草稿同步层提供的只读投影；组件不保存角色字段的第二份副本。 */
  draft: CharacterVoiceDraft
  provider: TtsProvider
  characterId?: string
  previewText?: string
  ports?: CharacterVoiceEditorPorts
}>(), {
  characterId: 'new',
  previewText: 'こんにちは、元気ですか？',
  ports: () => defaultCharacterVoiceEditorPorts,
})

const emit = defineEmits<{
  (event: 'change', field: CharacterVoiceDraftField, value: string): void
  (event: 'provider-change', provider: TtsProvider): void
}>()

const { t } = useI18n()
const availableVoices = ref<VoiceInfo[]>([])
const loadingVoices = ref(false)
const voiceError = ref('')
const previewError = ref('')
const referenceAudioError = ref('')
const voicePreviewing = ref(false)
let loadSequence = 0
let previewSequence = 0

const providerEnabled = computed(() => props.provider !== 'none')
const selectedVoiceInfo = computed(() => availableVoices.value.find(v => v.voiceId === props.draft.voice))

function change(field: CharacterVoiceDraftField, value: string) {
  emit('change', field, value)
}

function handleProviderChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as TtsProvider
  emit('provider-change', value)
}

async function loadVoices() {
  const sequence = ++loadSequence
  if (props.provider !== 'cosyvoice') {
    availableVoices.value = []
    voiceError.value = ''
    loadingVoices.value = false
    return
  }

  loadingVoices.value = true
  voiceError.value = ''
  try {
    const voices = await props.ports.loadVoices()
    if (sequence !== loadSequence) return
    availableVoices.value = voices
    if (voices.length === 0) voiceError.value = t('character.mgr.voiceNoneHint')
  } catch (error) {
    if (sequence !== loadSequence) return
    availableVoices.value = []
    // 音色加载失败只是诊断信息，其他字段仍保持可编辑。
    voiceError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (sequence === loadSequence) loadingVoices.value = false
  }
}

async function pickReferenceAudio() {
  referenceAudioError.value = ''
  if (!props.ports.pickReferenceAudio) return
  try {
    const path = await props.ports.pickReferenceAudio()
    if (typeof path === 'string') change('gptsovitsRefAudio', path)
  } catch (error) {
    referenceAudioError.value = error instanceof Error ? error.message : String(error)
  }
}

async function previewVoice() {
  if (!props.draft.voice || props.provider === 'none') return
  if (voicePreviewing.value) {
    props.ports.cancelPreview('preview-cancelled', true)
    voicePreviewing.value = false
    return
  }

  const sequence = ++previewSequence
  voicePreviewing.value = true
  previewError.value = ''
  // 取当前投影快照传给端口；试听不得通过 change 修改草稿或保存基线。
  const request: CharacterVoicePreviewRequest = {
    requestId: `voice-preview:${props.characterId}`,
    provider: props.provider,
    text: props.previewText,
    voiceId: props.draft.voice,
    voiceModel: props.draft.voiceModel,
    voiceLanguage: props.draft.voiceLanguage,
    textLanguage: props.draft.textLanguage,
    gptsovitsRefAudio: props.draft.gptsovitsRefAudio,
    gptsovitsPromptText: props.draft.gptsovitsPromptText,
    gptsovitsPromptLang: props.draft.gptsovitsPromptLang,
  }

  try {
    const result = await props.ports.preview(request)
    if (sequence !== previewSequence) return
    if (result?.status === 'failed') previewError.value = result.reason || '试听失败'
  } catch (error) {
    if (sequence !== previewSequence) return
    previewError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (sequence === previewSequence) voicePreviewing.value = false
  }
}

function cancelPreview() {
  if (!voicePreviewing.value) return
  ++previewSequence
  props.ports.cancelPreview('preview-cancelled', true)
  voicePreviewing.value = false
}

watch(() => props.provider, () => {
  // 切换能力来源时停止旧 provider 的试听，避免旧请求越过新草稿边界。
  cancelPreview()
  void loadVoices()
}, { immediate: true })
onBeforeUnmount(cancelPreview)
</script>

<template>
  <div class="character-voice-editor" data-testid="character-voice-editor">
    <div class="voice-editor-field">
      <label class="voice-editor-label">{{ t('settings.tts.provider') }}</label>
      <select class="voice-editor-select" :value="provider" @change="handleProviderChange">
        <option value="none">{{ t('settings.tts.providerNone') }}</option>
        <option value="cosyvoice">{{ t('settings.tts.providerCosyVoice') }}</option>
        <option value="gptsovits">{{ t('settings.tts.providerGptSoVits') }}</option>
      </select>
    </div>

    <template v-if="provider === 'cosyvoice'">
      <div class="voice-editor-field">
        <label class="voice-editor-label">{{ t('character.mgr.voiceTitle') }}</label>
        <div class="voice-editor-inline">
          <select class="voice-editor-select" :value="draft.voice" @change="change('voice', ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('character.mgr.voiceNone') }}</option>
            <option v-for="voice in availableVoices" :key="voice.voiceId" :value="voice.voiceId">
              {{ voice.voiceId }}
            </option>
          </select>
          <button type="button" class="voice-editor-icon-button" :disabled="loadingVoices" :title="t('character.mgr.voiceRefresh')" @click="loadVoices">
            <span class="sr-only">{{ t('character.mgr.voiceRefresh') }}</span>
            <i class="fas fa-sync" :class="{ spinning: loadingVoices }"></i>
          </button>
        </div>
        <p v-if="selectedVoiceInfo?.targetModel" class="voice-editor-hint">{{ selectedVoiceInfo.targetModel }}</p>
      </div>

      <div class="voice-editor-field">
        <label class="voice-editor-label">{{ t('settings.tts.modelLabel') }}</label>
        <input class="voice-editor-input" type="text" :value="draft.voiceModel" @input="change('voiceModel', ($event.target as HTMLInputElement).value)" />
      </div>
    </template>

    <template v-if="provider === 'gptsovits'">
      <div class="voice-editor-field">
        <label class="voice-editor-label">{{ t('character.mgr.gptsovitsRefAudio') }}</label>
        <div class="voice-editor-inline">
          <input class="voice-editor-input" type="text" readonly :value="draft.gptsovitsRefAudio" :placeholder="t('character.mgr.gptsovitsRefAudioPlaceholder')" @click="pickReferenceAudio" />
          <button type="button" class="voice-editor-icon-button" :title="t('character.mgr.gptsovitsPickAudio')" @click="pickReferenceAudio">
            <span class="sr-only">{{ t('character.mgr.gptsovitsPickAudio') }}</span>
            <i class="fas fa-folder-open"></i>
          </button>
        </div>
        <p v-if="referenceAudioError" class="voice-editor-error" role="alert" data-selectable>{{ referenceAudioError }}</p>
      </div>
      <div class="voice-editor-field">
        <label class="voice-editor-label">{{ t('character.mgr.gptsovitsPromptText') }}</label>
        <input class="voice-editor-input" type="text" :value="draft.gptsovitsPromptText" :placeholder="t('character.mgr.gptsovitsPromptTextPlaceholder')" @input="change('gptsovitsPromptText', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="voice-editor-field">
        <label class="voice-editor-label">{{ t('character.mgr.gptsovitsPromptLang') }}</label>
        <select class="voice-editor-select" :value="draft.gptsovitsPromptLang" @change="change('gptsovitsPromptLang', ($event.target as HTMLSelectElement).value)">
          <option v-for="language in SUPPORTED_LANGUAGES" :key="language.value" :value="language.value">{{ language.label }}</option>
        </select>
      </div>
    </template>

    <div v-if="providerEnabled" class="voice-editor-field">
      <div class="voice-editor-label">{{ t('character.mgr.groupVoiceLang') }}</div>
      <div class="voice-editor-language-grid">
        <label>
          <span class="voice-editor-sublabel">{{ t('character.mgr.ttsLang') }}</span>
          <select class="voice-editor-select" :value="draft.voiceLanguage" @change="change('voiceLanguage', ($event.target as HTMLSelectElement).value)">
            <option v-for="language in SUPPORTED_LANGUAGES" :key="language.value" :value="language.value">{{ language.label }}</option>
          </select>
        </label>
        <label>
          <span class="voice-editor-sublabel">{{ t('character.mgr.defaultDisplayLang') }}</span>
          <select class="voice-editor-select" :value="draft.textLanguage" @change="change('textLanguage', ($event.target as HTMLSelectElement).value)">
            <option v-for="language in SUPPORTED_LANGUAGES" :key="language.value" :value="language.value">{{ language.label }}</option>
          </select>
        </label>
      </div>
    </div>

    <div v-if="provider === 'cosyvoice'" class="voice-editor-preview">
      <button type="button" class="voice-editor-preview-button" :disabled="!draft.voice" :class="{ playing: voicePreviewing }" @click="previewVoice">
        <i :class="voicePreviewing ? 'fas fa-stop' : 'fas fa-play'"></i>
        {{ voicePreviewing ? t('character.mgr.previewStop') : t('character.mgr.preview') }}
      </button>
      <span class="voice-editor-preview-hint">{{ previewText }}</span>
    </div>

    <p v-if="voiceError" class="voice-editor-error" role="alert" data-selectable>{{ voiceError }}</p>
    <p v-if="previewError" class="voice-editor-error" role="alert" data-selectable>{{ previewError }}</p>
    <p v-if="provider === 'cosyvoice' && !voiceError && draft.voice" class="voice-editor-success">
      <i class="fas fa-check-circle"></i> {{ t('character.mgr.voiceSelectedHint') }}
    </p>
  </div>
</template>

<style scoped>
.character-voice-editor { display: grid; gap: 12px; }
.voice-editor-field { display: grid; gap: 6px; }
.voice-editor-label, .voice-editor-sublabel { color: #b9b7d4; font-size: 12px; }
.voice-editor-sublabel { display: block; margin-bottom: 5px; }
.voice-editor-input, .voice-editor-select { min-width: 0; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #3a3a5c; border-radius: 5px; background: #15152b; color: #eee; }
.voice-editor-inline { display: flex; gap: 6px; min-width: 0; }
.voice-editor-inline .voice-editor-input, .voice-editor-inline .voice-editor-select { flex: 1; }
.voice-editor-icon-button { flex: 0 0 34px; border: 1px solid #3a3a5c; border-radius: 5px; background: #20203c; color: #b9b7d4; cursor: pointer; }
.voice-editor-icon-button:disabled { opacity: .55; cursor: default; }
.voice-editor-language-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.voice-editor-preview { display: flex; align-items: center; gap: 8px; }
.voice-editor-preview-button { border: 1px solid #6252bc; border-radius: 5px; padding: 7px 11px; background: #302761; color: #fff; cursor: pointer; }
.voice-editor-preview-button:disabled { opacity: .55; cursor: default; }
.voice-editor-preview-hint, .voice-editor-hint { color: #8f8dab; font-size: 11px; overflow-wrap: anywhere; }
.voice-editor-error { margin: 0; color: #ff8f9a; font-size: 12px; }
.voice-editor-success { margin: 0; color: #75d39a; font-size: 12px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
