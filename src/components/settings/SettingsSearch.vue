<script setup lang="ts">
/**
 * 联网搜索设置 - 启用开关、provider 选择、Key / 自建实例地址
 */
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  loadSearchConfigSecure, saveSearchConfigSecure, isSearchConfigValid,
  DEFAULT_SEARCH_CONFIG, SEARCH_PROVIDERS,
} from '../../agent/tools/searchConfig'
import type { SearchConfig } from '../../agent/tools/searchConfig'

const { t } = useI18n()

const searchConfig = ref<SearchConfig>({ ...DEFAULT_SEARCH_CONFIG })
const searchSaved = ref(false)
const currentProvider = computed(() =>
  SEARCH_PROVIDERS.find(p => p.value === searchConfig.value.provider) ?? SEARCH_PROVIDERS[0],
)

onMounted(async () => {
  searchConfig.value = { ...await loadSearchConfigSecure() }
})

async function handleSearchSave() {
  await saveSearchConfigSecure(searchConfig.value)
  searchSaved.value = true
  setTimeout(() => { searchSaved.value = false }, 1500)
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-globe"></i> {{ t('settings.search.title') }}</h2>
    <p class="section-desc">{{ t('settings.search.desc') }}</p>

    <!-- 联网搜索总开关 -->
    <div class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.search.enable') }}</span>
          <span class="toggle-label-desc">{{ t('settings.search.enableDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: searchConfig.enabled }]"
          @click="searchConfig.enabled = !searchConfig.enabled" role="switch" :aria-checked="searchConfig.enabled">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <template v-if="searchConfig.enabled">
      <hr class="section-divider" />

      <div class="form-group">
        <label class="form-label">{{ t('settings.search.provider') }}</label>
        <div class="provider-tabs">
          <button
            v-for="p in SEARCH_PROVIDERS" :key="p.value"
            :class="['provider-tab', { active: searchConfig.provider === p.value }]"
            @click="searchConfig.provider = p.value"
          >
            <i class="fas" :class="p.icon"></i>
            {{ p.label }}
          </button>
        </div>
      </div>

      <div v-if="currentProvider.needsKey" class="form-group">
        <label class="form-label">{{ t('settings.search.apiKey') }}</label>
        <input v-model="searchConfig.apiKey" class="form-input" type="password" placeholder="tvly-..." />
        <p class="form-hint">{{ t('settings.search.keyHint') }}</p>
      </div>

      <div v-if="currentProvider.needsBaseURL" class="form-group">
        <label class="form-label">{{ t('settings.search.baseURL') }}</label>
        <input v-model="searchConfig.baseURL" class="form-input" :placeholder="t('settings.search.baseURLPlaceholder')" />
      </div>
    </template>

    <div class="form-actions">
      <button class="btn-save" @click="handleSearchSave">
        {{ searchSaved ? t('common.saved') : t('common.save') }}
      </button>
      <span v-if="isSearchConfigValid(searchConfig)" class="status-ok"><i class="fas fa-check-circle"></i> {{ t('settings.search.configOk') }}</span>
    </div>
  </div>
</template>
