<script setup lang="ts">
/**
 * API 配置 - 预设、baseURL、apiKey、model
 */
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadConfigSecure, saveConfigSecure, DEFAULT_CONFIG, isConfigValid } from '../../ai'
import type { AIConfig } from '../../ai'
import {
  loadSearchConfigSecure, saveSearchConfigSecure, isSearchConfigValid,
  DEFAULT_SEARCH_CONFIG, SEARCH_PROVIDERS,
} from '../../agent/tools/searchConfig'
import type { SearchConfig } from '../../agent/tools/searchConfig'

const { t } = useI18n()

const config = ref<AIConfig>({ ...DEFAULT_CONFIG })
const saved = ref(false)

// ─── 联网搜索配置 ───
const searchConfig = ref<SearchConfig>({ ...DEFAULT_SEARCH_CONFIG })
const searchSaved = ref(false)
const currentProvider = computed(() =>
  SEARCH_PROVIDERS.find(p => p.value === searchConfig.value.provider) ?? SEARCH_PROVIDERS[0],
)

const PRESETS = [
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3' },
]

onMounted(async () => {
  config.value = { ...await loadConfigSecure() }
  searchConfig.value = { ...await loadSearchConfigSecure() }
})

function applyPreset(p: typeof PRESETS[0]) {
  config.value.baseURL = p.baseURL
  config.value.model = p.model
}

async function handleSave() {
  await saveConfigSecure(config.value)
  saved.value = true
  setTimeout(() => { saved.value = false }, 1500)
}

async function handleSearchSave() {
  await saveSearchConfigSecure(searchConfig.value)
  searchSaved.value = true
  setTimeout(() => { searchSaved.value = false }, 1500)
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title">{{ t('settings.api.title') }}</h2>
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
    </div>

    <div class="form-actions">
      <button class="btn-save" @click="handleSave">
        {{ saved ? t('common.saved') : t('common.save') }}
      </button>
      <span v-if="isConfigValid(config)" class="status-ok"><i class="fas fa-check-circle"></i> {{ t('settings.api.configOk') }}</span>
    </div>
  </div>

  <div class="content-section">
    <h2 class="section-title">{{ t('settings.search.title') }}</h2>
    <p class="section-desc">{{ t('settings.search.desc') }}</p>

    <div class="form-group">
      <label class="switch-row">
        <input v-model="searchConfig.enabled" type="checkbox" />
        <span>{{ t('settings.search.enable') }}</span>
      </label>
    </div>

    <div class="form-group">
      <label class="form-label">{{ t('settings.search.provider') }}</label>
      <div class="preset-row">
        <button
          v-for="p in SEARCH_PROVIDERS" :key="p.value"
          class="preset-btn" :class="{ active: searchConfig.provider === p.value }"
          @click="searchConfig.provider = p.value"
        >
          {{ p.label }}
        </button>
      </div>
    </div>

    <div v-if="currentProvider.needsKey" class="form-group">
      <label class="form-label">{{ t('settings.search.apiKey') }}</label>
      <input v-model="searchConfig.apiKey" class="form-input" type="password" placeholder="tvly-..." />
      <p class="field-hint">{{ t('settings.search.keyHint') }}</p>
    </div>

    <div v-if="currentProvider.needsBaseURL" class="form-group">
      <label class="form-label">{{ t('settings.search.baseURL') }}</label>
      <input v-model="searchConfig.baseURL" class="form-input" :placeholder="t('settings.search.baseURLPlaceholder')" />
    </div>

    <div class="form-actions">
      <button class="btn-save" @click="handleSearchSave">
        {{ searchSaved ? t('common.saved') : t('common.save') }}
      </button>
      <span v-if="isSearchConfigValid(searchConfig)" class="status-ok"><i class="fas fa-check-circle"></i> {{ t('settings.search.configOk') }}</span>
    </div>
  </div>
</template>
