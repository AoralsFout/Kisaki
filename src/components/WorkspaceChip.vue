<script setup lang="ts">
/**
 * 工作区条 —— 主窗口内展示/管理「当前会话的 AI 工作目录」
 *
 * - 未授权：显示「设置工作区」按钮，点击弹目录选择框。
 * - 已授权：显示目录名（title 挂全路径），点名字可重新选目录；右侧 ✕ 取消授权。
 * 工作目录按会话存储（session.workspaceRoot），切换会话自动反映。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore } from '../stores/session'
import { createLogger } from '../utils/logger'

const log = createLogger('WorkspaceChip')
const { t } = useI18n()
const sessionStore = useSessionStore()

const root = computed(() => sessionStore.currentSession?.workspaceRoot ?? null)

/** 取路径末段作为显示名（兼容 / 与 \ 分隔） */
const displayName = computed(() => {
  const p = root.value
  if (!p) return ''
  const parts = p.split(/[/\\]+/).filter(Boolean)
  return parts[parts.length - 1] || p
})

async function pickDirectory() {
  try {
    const grant = await invoke<{ id: string; path: string } | null>('agent_pick_workspace', {
      title: t('app.workspace.pickTitle'),
    })
    if (grant) {
      sessionStore.setWorkspace(grant)
    }
  } catch (err) {
    log.warn('选择工作目录失败: %s', (err as Error).message)
  }
}

function clearWorkspace() {
  sessionStore.clearWorkspace()
}
</script>

<template>
  <div class="workspace-chip" data-pet-solid>
    <template v-if="root">
      <button class="ws-main" :title="root" @click="pickDirectory" :aria-label="t('app.workspace.change')">
        <i class="fas fa-folder-open ws-icon"></i>
        <span class="ws-name">{{ displayName }}</span>
      </button>
      <button class="ws-clear" @click="clearWorkspace" :aria-label="t('app.workspace.clear')">
        <i class="fas fa-xmark"></i>
      </button>
    </template>
    <button v-else class="ws-main ws-empty" @click="pickDirectory" :aria-label="t('app.workspace.set')">
      <i class="fas fa-folder ws-icon"></i>
      <span class="ws-name">{{ t('app.workspace.set') }}</span>
    </button>
  </div>
</template>

<style scoped>
.workspace-chip {
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(8px);
  padding: 4px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.ws-main {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  border-radius: 20px;
  transition: background 0.15s;
  min-width: 0;
}

.ws-main:hover {
  background: rgba(255, 255, 255, 0.1);
}

.ws-icon {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.75);
  flex-shrink: 0;
}

.ws-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ws-empty .ws-name {
  color: rgba(255, 255, 255, 0.6);
}

.ws-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  width: 20px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
  transition: background 0.15s, color 0.15s;
}

.ws-clear:hover {
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.9);
}
</style>
