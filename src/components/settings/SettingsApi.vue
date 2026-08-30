<script setup lang="ts">
/**
 * API 配置 - 预设、baseURL、apiKey、model
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadConfigSecure, saveConfigSecure, DEFAULT_CONFIG, isConfigValid, testAIConnection } from '../../ai'
import type { AIConfig } from '../../ai'
import { emit } from '@tauri-apps/api/event'
import { EVENT_AI_CONFIG_CHANGED } from '../../constants'

const { t } = useI18n()

const config = ref<AIConfig>({ ...DEFAULT_CONFIG })
const saved = ref(false)
const testing = ref(false)
const testResult = ref<'ok' | 'error' | ''>('')
const testMessage = ref('')

const PRESETS = [
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3' },
]

onMounted(async () => {
  config.value = { ...await loadConfigSecure() }
})

function applyPreset(p: typeof PRESETS[0]) {
  config.value.baseURL = p.baseURL
  config.value.model = p.model
}

async function handleSave() {
  await saveConfigSecure(config.value)
  await emit(EVENT_AI_CONFIG_CHANGED).catch(() => { /* 浏览器预览环境无 Tauri 事件 */ })
  saved.value = true
  setTimeout(() => { saved.value = false }, 1500)
}

async function handleTest() {
  testing.value = true
  testResult.value = ''
  testMessage.value = ''
  const result = await testAIConnection(config.value)
  testing.value = false
  testResult.value = result.ok ? 'ok' : 'error'
  testMessage.value = result.ok
    ? t('settings.api.testOk')
    : t('settings.api.testFailed', { msg: result.error || t('settings.api.testUnknown') })
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-plug"></i> {{ t('settings.api.title') }}</h2>
    <p class="section-desc">{{ t('settings.api.desc') }}</p>

    <div class="form-group">
      <label class="form-label">{{ t('settings.api.quickSelect') }}</label>
      <div class="preset-row">
        <button v-for="p in PRESETS" :key="p.label" class="preset-btn" @click="applyPreset(p)">
          {{ p.label }}
        </button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">{{ t('settings.api.baseURL') }}</label>
      <input v-model="config.baseURL" class="form-input" placeholder="https://api.openai.com/v1" />
    </div>

    <div class="form-group">
      <label class="form-label">{{ t('settings.api.apiKey') }}</label>
      <input v-model="config.apiKey" class="form-input" type="password" placeholder="sk-..." />
    </div>

    <div class="form-group">
      <label class="form-label">{{ t('settings.api.model') }}</label>
      <input v-model="config.model" class="form-input" placeholder="gpt-4o-mini" />
      <p class="form-hint">{{ t('settings.api.visionHint') }}</p>
    </div>

    <div class="form-actions">
      <button class="btn-save" @click="handleSave">
        {{ saved ? t('common.saved') : t('common.save') }}
      </button>
      <button class="btn-secondary" :disabled="testing || !isConfigValid(config)" @click="handleTest">
        {{ testing ? t('settings.api.testing') : t('settings.api.test') }}
      </button>
      <span v-if="isConfigValid(config)" class="status-ok"><i class="fas fa-check-circle"></i> {{ t('settings.api.configOk') }}</span>
    </div>
    <p v-if="testMessage" :class="testResult === 'ok' ? 'status-ok' : 'status-error'">{{ testMessage }}</p>
  </div>
</template>
