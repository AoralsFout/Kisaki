<script setup lang="ts">
/**
 * 隐私政策
 *
 * 向用户说明数据如何被存储与使用。文案经 i18n 分发，见各 locales 的
 * settings.privacy 命名空间。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import {
  STORAGE_AI_CONFIG,
  STORAGE_COSYVOICE_CONFIG,
  STORAGE_CURRENT_SESSION,
  STORAGE_SEARCH_CONFIG,
  STORAGE_SESSIONS,
} from '../../constants'
import { keychainDelete } from '../../utils/secretStore'
import { disableFilePersistence } from '../../utils/logger'

const { t } = useI18n()
const busy = ref(false)
const status = ref('')
const error = ref('')

const EXCLUDED_BACKUP_KEYS = new Set([
  STORAGE_AI_CONFIG,
  STORAGE_COSYVOICE_CONFIG,
  STORAGE_SEARCH_CONFIG,
  STORAGE_SESSIONS,
  STORAGE_CURRENT_SESSION,
])

function safeSettingsSnapshot(): string {
  const values: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || EXCLUDED_BACKUP_KEYS.has(key)) continue
    const value = localStorage.getItem(key)
    if (value !== null) values[key] = value
  }
  return JSON.stringify(values)
}

function applySafeSettings(raw: string) {
  const values = JSON.parse(raw) as Record<string, unknown>
  for (const [key, value] of Object.entries(values)) {
    if (EXCLUDED_BACKUP_KEYS.has(key) || typeof value !== 'string') continue
    localStorage.setItem(key, value)
  }
}

async function exportBackup() {
  const dest = await save({
    defaultPath: 'kisaki-backup.zip',
    filters: [{ name: t('settings.privacy.actions.backupFilter'), extensions: ['zip'] }],
  })
  if (!dest) return
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    await invoke('export_data_backup', { destPath: dest, settingsJson: safeSettingsSnapshot() })
    status.value = t('settings.privacy.actions.exportDone')
  } catch (e) {
    error.value = t('settings.privacy.actions.failed', { msg: String(e) })
  } finally {
    busy.value = false
  }
}

async function importBackup() {
  if (!window.confirm(t('settings.privacy.actions.importConfirm'))) return
  const selected = await open({
    multiple: false,
    filters: [{ name: t('settings.privacy.actions.backupFilter'), extensions: ['zip'] }],
  })
  if (!selected || Array.isArray(selected)) return
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    const settingsJson = await invoke<string>('import_data_backup', { srcPath: selected })
    applySafeSettings(settingsJson)
    await relaunch()
  } catch (e) {
    error.value = t('settings.privacy.actions.failed', { msg: String(e) })
    busy.value = false
  }
}

async function clearAllData() {
  if (!window.confirm(t('settings.privacy.actions.clearConfirm'))) return
  busy.value = true
  error.value = ''
  status.value = ''
  try {
    disableFilePersistence()
    await invoke('reset_all_local_data')
    await Promise.all([
      keychainDelete('ai_api_key'),
      keychainDelete('cosyvoice_api_key'),
      keychainDelete('search_api_key'),
    ])
    localStorage.clear()
    await relaunch()
  } catch (e) {
    error.value = t('settings.privacy.actions.failed', { msg: String(e) })
    busy.value = false
  }
}

const SECTIONS = [
  { key: 'local', icon: 'fa-database' },
  { key: 'network', icon: 'fa-globe' },
  { key: 'logs', icon: 'fa-receipt' },
  { key: 'delete', icon: 'fa-trash-can' },
] as const
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-shield-halved"></i> {{ t('settings.privacy.title') }}</h2>
    <p class="section-desc">{{ t('settings.privacy.desc') }}</p>

    <div v-for="s in SECTIONS" :key="s.key" class="privacy-section">
      <h3 class="privacy-title">
        <i class="fas" :class="s.icon"></i> {{ t(`settings.privacy.${s.key}.title`) }}
      </h3>
      <p class="privacy-body">{{ t(`settings.privacy.${s.key}.body`) }}</p>
    </div>

    <div class="privacy-note">
      <i class="fas fa-circle-check"></i> {{ t('settings.privacy.noTelemetry') }}
    </div>

    <div class="privacy-actions">
      <button class="privacy-btn" :disabled="busy" @click="exportBackup">
        <i class="fas fa-box-archive"></i> {{ t('settings.privacy.actions.export') }}
      </button>
      <button class="privacy-btn" :disabled="busy" @click="importBackup">
        <i class="fas fa-rotate-left"></i> {{ t('settings.privacy.actions.import') }}
      </button>
      <button class="privacy-btn danger" :disabled="busy" @click="clearAllData">
        <i class="fas fa-trash-can"></i> {{ t('settings.privacy.actions.clear') }}
      </button>
    </div>
    <p class="privacy-action-hint">{{ t('settings.privacy.actions.hint') }}</p>
    <p v-if="status" class="privacy-status">{{ status }}</p>
    <p v-if="error" class="privacy-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.privacy-section {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 12px;
}

.privacy-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.privacy-title i {
  color: var(--c-brand);
  width: 16px;
  text-align: center;
}

.privacy-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--c-text-secondary);
}

.privacy-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 12px 16px;
  font-size: 13px;
  color: var(--c-ok);
  background: rgba(48, 185, 78, 0.08);
  border: 1px solid rgba(48, 185, 78, 0.2);
  border-radius: 10px;
}

.privacy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 18px;
}

.privacy-btn {
  padding: 9px 14px;
  border: 1px solid #3a3a58;
  border-radius: 9px;
  background: #202038;
  color: var(--c-text);
  cursor: pointer;
}

.privacy-btn:disabled { opacity: 0.55; cursor: wait; }
.privacy-btn.danger { border-color: #7a3540; color: #ff9ba8; }
.privacy-action-hint { color: var(--c-text-muted); font-size: 12px; line-height: 1.6; }
.privacy-status { color: var(--c-ok); font-size: 13px; }
.privacy-error { color: var(--c-error-text); font-size: 13px; word-break: break-word; }
</style>
