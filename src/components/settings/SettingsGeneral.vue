<script setup lang="ts">
/**
 * 通用设置 - 语言、自动执行
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { UI_LANGUAGES, getUiLanguage, setUiLanguage } from '../../i18n'
import { getAutoExecFiles, setAutoExecFiles } from '../../agent/toolPolicy'

const { t } = useI18n()

const uiLang = ref(getUiLanguage())
const autoExec = ref(getAutoExecFiles())

function onUiLangChange() {
  setUiLanguage(uiLang.value)
}

function onAutoExecChange() {
  autoExec.value = !autoExec.value
  setAutoExecFiles(autoExec.value)
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title">{{ t('settings.general.title') }}</h2>
    <p class="section-desc">{{ t('settings.general.desc') }}</p>

    <div class="form-group">
      <label class="form-label">{{ t('settings.general.uiLang') }}</label>
      <select v-model="uiLang" class="form-select" @change="onUiLangChange">
        <option v-for="l in UI_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
      </select>
      <p class="form-hint">{{ t('settings.general.uiLangHint') }}</p>
    </div>

    <hr class="section-divider" />

    <div class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.general.autoExecTitle') }}</span>
          <span class="toggle-label-desc">{{ t('settings.general.autoExecDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: autoExec }]"
          @click="onAutoExecChange" role="switch" :aria-checked="autoExec">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>
  </div>
</template>
