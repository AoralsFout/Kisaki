<script setup lang="ts">
/**
 * 诊断 - 日志查看与问题排查入口
 *
 * 从「关于」页迁移而来：日志窗口独立于设置窗口打开。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getAllWindows } from '@tauri-apps/api/window'
import { WINDOW_LOGS, QUERY_LOGS } from '../../constants'
import {
  createLogger,
  getLogRetentionDays,
  isSensitiveDiagnosticsEnabled,
  setLogRetentionDays,
  setSensitiveDiagnosticsEnabled,
} from '../../utils/logger'
import ToggleRow from '../ui/ToggleRow.vue'

const log = createLogger('SettingsDiagnostics')
const { t } = useI18n()
const sensitiveDiagnostics = ref(isSensitiveDiagnosticsEnabled())
const retentionDays = ref(getLogRetentionDays())

function onSensitiveDiagnosticsChange() {
  setSensitiveDiagnosticsEnabled(sensitiveDiagnostics.value)
}

function onRetentionChange() {
  void setLogRetentionDays(retentionDays.value)
}

async function openLogWindow() {
  try {
    const all = await getAllWindows()
    const existing = all.find(w => w.label === WINDOW_LOGS)
    if (existing) {
      await existing.unminimize()
      await existing.show()
      await existing.setFocus()
      return
    }

    new WebviewWindow(WINDOW_LOGS, {
      url: `/?${QUERY_LOGS}=1`,
      title: t('window.logs'),
      width: 800,
      height: 500,
      decorations: false,
      resizable: true,
      visible: false,
    })
  } catch (e) {
    log.error("settings_diagnostics.open_log_window.error", "无法打开日志窗口", e)
  }
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-clipboard-list"></i> {{ t('settings.diagnostics.title') }}</h2>
    <p class="section-desc">{{ t('settings.diagnostics.desc') }}</p>

    <ToggleRow v-model:checked="sensitiveDiagnostics"
      :title="t('settings.diagnostics.sensitiveTitle')"
      :desc="t('settings.diagnostics.sensitiveDesc')"
      @update:checked="onSensitiveDiagnosticsChange" />

    <div class="form-group">
      <label class="form-label">{{ t('settings.diagnostics.retentionTitle') }}</label>
      <select v-model.number="retentionDays" class="form-select" @change="onRetentionChange">
        <option :value="7">7</option>
        <option :value="14">14</option>
        <option :value="30">30</option>
        <option :value="90">90</option>
      </select>
      <p class="form-hint">{{ t('settings.diagnostics.retentionDesc', { days: retentionDays }) }}</p>
    </div>

    <button class="btn-open-logs" @click="openLogWindow">
      <i class="fas fa-receipt"></i> {{ t('settings.diagnostics.openLogs') }}
    </button>
    <p class="form-hint">{{ t('settings.diagnostics.logsHint') }}</p>
  </div>
</template>
