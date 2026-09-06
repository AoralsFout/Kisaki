<script setup lang="ts">
/**
 * 关于 - 版本信息、链接、退出
 *
 * 日志查看入口在「维护与帮助 → 诊断」。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getAllWindows } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

const { t } = useI18n()
const appVersion = __APP_VERSION__

// ── 自动更新 ──
type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'installed' | 'error'
const updateState = ref<UpdateState>('idle')
const updateMessage = ref('')
const updateVersion = ref('')
let pendingUpdate: Awaited<ReturnType<typeof check>> = null

async function checkUpdate() {
  updateState.value = 'checking'
  updateMessage.value = ''
  try {
    const update = await check()
    if (!update) {
      updateState.value = 'up-to-date'
      return
    }
    pendingUpdate = update
    updateVersion.value = update.version
    updateState.value = 'available'
  } catch (e) {
    updateState.value = 'error'
    updateMessage.value = (e as Error)?.message || String(e)
  }
}

async function downloadUpdate() {
  if (!pendingUpdate) return
  updateState.value = 'downloading'
  try {
    await pendingUpdate.downloadAndInstall()
    // 安装完成后自动重启、立即生效；relaunch 失败则回退为「手动重启」提示
    try {
      await relaunch()
    } catch {
      updateState.value = 'installed'
    }
  } catch (e) {
    updateState.value = 'error'
    updateMessage.value = (e as Error)?.message || String(e)
  }
}

async function openCharacterFolder() {
  try {
    const dirs = await invoke<{ characters: string }>('get_data_dirs')
    await revealItemInDir(dirs.characters)
  } catch (e) {
    console.error('打开角色数据文件夹失败:', e)
  }
}

async function exitApp() {
  try {
    const all = await getAllWindows()
    for (const w of all) {
      try { await w.close() } catch { }
    }
  } catch { }
}

</script>

<template>
  <div class="content-section">
    <h2 class="section-title">{{ t('settings.about.title') }}</h2>
    <p class="section-desc">Kisaki v{{ appVersion }}</p>
    <div class="about-card">
      <img src="/images/kisaki_alpha.png" height="100" />
      <img src="/images/kisaki_logo_alpha.png" height="70" />
      <p>{{ t('settings.about.desc1') }}</p>
      <p>{{ t('settings.about.desc2') }}</p>
      <p style="margin-top:12px;color:#999;font-size:12px;">
        {{ t('settings.about.privacy') }}
      </p>
      <hr class="section-divider" />

      <!-- 自动更新 -->
      <div class="update-row">
        <button class="btn-open-logs" style="margin-bottom:0;"
          :disabled="updateState === 'checking' || updateState === 'downloading'"
          @click="checkUpdate">
          <i class="fas fa-rotate" :class="{ spinning: updateState === 'checking' || updateState === 'downloading' }"></i>
          {{ t('settings.about.checkUpdate') }}
        </button>
        <button v-if="updateState === 'available'" class="btn-open-logs" style="margin-bottom:0;"
          @click="downloadUpdate">
          <i class="fas fa-download"></i> {{ t('settings.about.updateDownload') }}
        </button>
      </div>

      <p v-if="updateState !== 'idle'" class="update-status" :class="updateState">
        <template v-if="updateState === 'checking'">{{ t('settings.about.updateChecking') }}</template>
        <template v-else-if="updateState === 'up-to-date'">{{ t('settings.about.updateUpToDate') }}</template>
        <template v-else-if="updateState === 'available'">{{ t('settings.about.updateFound', { version: updateVersion }) }}</template>
        <template v-else-if="updateState === 'downloading'">{{ t('settings.about.updateDownloading') }}</template>
        <template v-else-if="updateState === 'installed'">{{ t('settings.about.updateInstalled') }}</template>
        <template v-else-if="updateState === 'error'">{{ t('settings.about.updateError', { msg: updateMessage }) }}</template>
      </p>
      <p class="form-hint">{{ t('settings.about.updateHint') }}</p>

      <hr class="section-divider" />
      <div class="about-links">
        <a class="about-link" href="https://github.com/AoralsFout/Kisaki" target="_blank"
          rel="noopener noreferrer">
          <i class="fab fa-github"></i> {{ t('settings.about.github') }}
        </a>
        <a class="about-link" href="https://kisaki.aoralsfout.top" target="_blank" rel="noopener noreferrer">
          <i class="fas fa-globe"></i> {{ t('settings.about.website') }}
        </a>
      </div>
      <hr class="section-divider" />
      <button class="btn-open-logs" @click="openCharacterFolder">
        <i class="fas fa-folder-open"></i> {{ t('settings.about.openCharFolder') }}
      </button>
      <hr class="section-divider" />
      <button class="btn-exit-app" @click="exitApp">
        <i class="fas fa-power-off"></i> {{ t('settings.about.exitApp') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.update-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.update-status {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.update-status.checking,
.update-status.downloading {
  color: #ffa726;
}

.update-status.up-to-date,
.update-status.installed {
  color: #30b94e;
}

.update-status.available {
  color: #9bb4ff;
}

.update-status.error {
  color: #ef5350;
}
</style>
