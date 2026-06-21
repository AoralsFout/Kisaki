<script setup lang="ts">
/**
 * 关于 - 版本信息、链接、退出
 */
import { useI18n } from 'vue-i18n'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getAllWindows } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { WINDOW_LOGS, QUERY_LOGS } from '../../constants'

const { t } = useI18n()
const appVersion = __APP_VERSION__

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
    })
  } catch (e) {
    console.error('无法打开日志窗口', e)
  }
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
      <button class="btn-open-logs" @click="openLogWindow">
        <i class="fas fa-receipt"></i> {{ t('settings.about.openLogs') }}
      </button>
      <hr class="section-divider" />
      <button class="btn-exit-app" @click="exitApp">
        <i class="fas fa-power-off"></i> {{ t('settings.about.exitApp') }}
      </button>
    </div>
  </div>
</template>
