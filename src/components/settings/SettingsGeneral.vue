<script setup lang="ts">
/**
 * 通用设置 - 语言、自动执行
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import { UI_LANGUAGES, getUiLanguage, setUiLanguage } from '../../i18n'
import { getAutoExecFiles, setAutoExecFiles, getCommandEnabled, setCommandEnabled } from '../../agent/toolPolicy'
import { createLogger } from '../../utils/logger'

const log = createLogger('SettingsGeneral')
const { t } = useI18n()

const uiLang = ref(getUiLanguage())
const autoExec = ref(getAutoExecFiles())
const commandEnabled = ref(getCommandEnabled())

// ── 开机自启 ──
const autoStart = ref(false)
const autoStartSupported = ref(false)

function onUiLangChange() {
  setUiLanguage(uiLang.value)
}

function onAutoExecChange() {
  autoExec.value = !autoExec.value
  setAutoExecFiles(autoExec.value)
}

function onCommandEnabledChange() {
  commandEnabled.value = !commandEnabled.value
  setCommandEnabled(commandEnabled.value)
}

async function refreshAutoStart() {
  try {
    autoStart.value = await isEnabled()
    autoStartSupported.value = true
  } catch {
    autoStartSupported.value = false
  }
}

async function onAutoStartChange() {
  try {
    if (autoStart.value) await enable()
    else await disable()
  } catch (e) {
    log.warn('开机自启切换失败', e)
    await refreshAutoStart()
  }
}

onMounted(() => { void refreshAutoStart() })
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-sliders"></i> {{ t('settings.general.title') }}</h2>
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

    <div class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.general.commandTitle') }}</span>
          <span class="toggle-label-desc">{{ t('settings.general.commandDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: commandEnabled }]"
          @click="onCommandEnabledChange" role="switch" :aria-checked="commandEnabled">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <hr class="section-divider" />

    <!-- 开机自启（仅在插件可用时显示） -->
    <div v-if="autoStartSupported" class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.general.autostartTitle') }}</span>
          <span class="toggle-label-desc">{{ t('settings.general.autostartDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: autoStart }]"
          @click="autoStart = !autoStart; onAutoStartChange()" role="switch" :aria-checked="autoStart">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <!-- 全局快捷键说明 -->
    <div class="form-group">
      <div class="shortcut-hint">
        <i class="fas fa-keyboard"></i>
        <div>
          <div class="shortcut-title">{{ t('settings.general.shortcutTitle') }}</div>
          <div class="shortcut-desc">{{ t('settings.general.shortcutDesc') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcut-hint {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 10px;
}

.shortcut-hint > i {
  color: #4a7aff;
  font-size: 15px;
  margin-top: 2px;
}

.shortcut-title {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e0;
}

.shortcut-desc {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
}
</style>
