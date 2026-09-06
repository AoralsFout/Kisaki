<script setup lang="ts">
/**
 * 诊断 - 日志查看与问题排查入口
 *
 * 从「关于」页迁移而来：日志窗口独立于设置窗口打开。
 */
import { useI18n } from 'vue-i18n'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getAllWindows } from '@tauri-apps/api/window'
import { WINDOW_LOGS, QUERY_LOGS } from '../../constants'
import { createLogger } from '../../utils/logger'

const log = createLogger('SettingsDiagnostics')
const { t } = useI18n()

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
    log.error('无法打开日志窗口', e)
  }
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-clipboard-list"></i> {{ t('settings.diagnostics.title') }}</h2>
    <p class="section-desc">{{ t('settings.diagnostics.desc') }}</p>

    <button class="btn-open-logs" @click="openLogWindow">
      <i class="fas fa-receipt"></i> {{ t('settings.diagnostics.openLogs') }}
    </button>
    <p class="form-hint">{{ t('settings.diagnostics.logsHint') }}</p>
  </div>
</template>
