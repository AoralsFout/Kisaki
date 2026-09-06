<script setup lang="ts">
/**
 * 通用设置 - 界面语言、外观与系统集成
 *
 * AI 工具授权（自动执行文件修改、本地任务执行）已迁移至「连接与能力 → 权限」。
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import { UI_LANGUAGES, getUiLanguage, setUiLanguage } from '../../i18n'
import { createLogger } from '../../utils/logger'
import {
  isCharacterOpacityWheelEnabled,
  setCharacterOpacityWheelEnabled,
} from '../../character/opacity'
import { isReducedMotionEnabled, setReducedMotionEnabled } from '../../utils/motionPreference'
import ToggleRow from '../ui/ToggleRow.vue'

const log = createLogger('SettingsGeneral')
const { t } = useI18n()

const uiLang = ref(getUiLanguage())
const opacityWheelEnabled = ref(isCharacterOpacityWheelEnabled())
const reducedMotionEnabled = ref(isReducedMotionEnabled())

// ── 开机自启 ──
const autoStart = ref(false)
const autoStartSupported = ref(false)

function onUiLangChange() {
  setUiLanguage(uiLang.value)
}

function onOpacityWheelEnabledChange(enabled: boolean) {
  setCharacterOpacityWheelEnabled(enabled)
}

function onReducedMotionEnabledChange(enabled: boolean) {
  setReducedMotionEnabled(enabled)
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

    <ToggleRow v-model:checked="opacityWheelEnabled" :title="t('settings.general.opacityWheelTitle')"
      :desc="t('settings.general.opacityWheelDesc')" @update:checked="onOpacityWheelEnabledChange" />

    <hr class="section-divider" />

    <ToggleRow v-model:checked="reducedMotionEnabled" :title="t('settings.general.reducedMotionTitle')"
      :desc="t('settings.general.reducedMotionDesc')" @update:checked="onReducedMotionEnabledChange" />

    <hr class="section-divider" />

    <!-- 开机自启（仅在插件可用时显示） -->
    <ToggleRow v-if="autoStartSupported" v-model:checked="autoStart" :title="t('settings.general.autostartTitle')"
      :desc="t('settings.general.autostartDesc')" @update:checked="onAutoStartChange" />

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
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 10px;
}

.shortcut-hint > i {
  color: var(--c-brand);
  font-size: 15px;
  margin-top: 2px;
}

.shortcut-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.shortcut-desc {
  font-size: 12px;
  color: var(--c-text-muted);
  margin-top: 2px;
}
</style>
