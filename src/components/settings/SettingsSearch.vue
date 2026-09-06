<script setup lang="ts">
/**
 * 联网搜索设置 - 启用开关、provider 选择、Key / 自建实例地址
 */
import { ref, onMounted, computed } from 'vue'
import { useEditableForm } from '../../utils/editableForm'
import { useI18n } from 'vue-i18n'
import {
  loadSearchConfigSecure, saveSearchConfigSecure,
  DEFAULT_SEARCH_CONFIG, SEARCH_PROVIDERS,
} from '../../agent/tools/searchConfig'
import type { SearchConfig } from '../../agent/tools/searchConfig'
import SaveBar from '../ui/SaveBar.vue'
import ToggleRow from '../ui/ToggleRow.vue'

const { t } = useI18n()

const searchConfig = ref<SearchConfig>({ ...DEFAULT_SEARCH_CONFIG })
const form = useEditableForm(() => searchConfig.value, async value => {
  await saveSearchConfigSecure(value)
})
const { dirty, saving, error, saved: searchSaved } = form
defineExpose({ dirty, saving, save: form.save })
const currentProvider = computed(() =>
  SEARCH_PROVIDERS.find(p => p.value === searchConfig.value.provider) ?? SEARCH_PROVIDERS[0],
)

onMounted(async () => {
  searchConfig.value = { ...await loadSearchConfigSecure() }
  form.reset()
})

async function handleSearchSave() { return form.save() }
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-globe"></i> {{ t('settings.search.title') }}</h2>
    <p class="section-desc">{{ t('settings.search.desc') }}</p>

    <!-- 联网搜索总开关 -->
    <ToggleRow v-model:checked="searchConfig.enabled" :title="t('settings.search.enable')"
      :desc="t('settings.search.enableDesc')" />

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

    <p v-if="dirty" class="form-hint">{{ t('safety.unsaved') }}</p>
    <SaveBar :saving="saving" :saved="searchSaved" :dirty="dirty" :error="error" @save="handleSearchSave">
      <template #status>
        <span v-if="searchSaved && !dirty" class="status-ok"><i class="fas fa-check-circle"></i> {{ t('settings.search.savedOk') }}</span>
      </template>
    </SaveBar>
  </div>
</template>
