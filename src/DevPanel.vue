<script setup lang="ts">
/**
 * 开发者调试面板
 *
 * 测试立绘的姿势、情绪、服装和屏幕位置控制。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useCharacterController, POSE_PRESETS, useCharacterStore, findImages } from './character'
import type { PoseKey } from './character'
import { createLogger } from './utils/logger'
import { CHANNEL_DESKPET_DEV } from './constants'

const log = createLogger('DevPanel')

const { t } = useI18n()

const charStore = useCharacterStore()
const controller = useCharacterController()

/** BroadcastChannel 向主窗口发指令 */
let devChannel: BroadcastChannel | null = null
try { devChannel = new BroadcastChannel(CHANNEL_DESKPET_DEV) } catch { }

function sendToMain(type: string, payload: any) {
  devChannel?.postMessage({ type, payload })
}

const isDevWindow = ref(false)
const selfWindow = ref<WebviewWindow | null>(null)

onMounted(async () => {
  const params = new URLSearchParams(window.location.search)
  isDevWindow.value = params.has('dev')
  if (isDevWindow.value) {
    selfWindow.value = getCurrentWebviewWindow()
  }
  // 确保角色数据已加载
  if (!charStore.data) {
    await charStore.init()
  }
  controller.init()

  log.info('DevPanel 挂载 %s', isDevWindow.value ? '(独立窗口)' : '(嵌入式)')

  // 请求主窗口同步当前状态
  sendToMain('request-state', {})

  // 监听主窗口发来的状态更新
  devChannel?.addEventListener('message', (event) => {
    const { type, payload } = event.data ?? {}
    if (type === 'state-update' && payload) {
      if (payload.poseTag) controller.setPoseTag(payload.poseTag)
      if (payload.emotion) controller.setEmotion(payload.emotion)
      if (payload.costume) controller.setCostume(payload.costume)
    }
  })
})

onUnmounted(() => {
  if (isDevWindow.value) controller.dispose()
})

// ---- 屏幕姿态 ----
const activeScale = ref<'full' | 'half' | 'headshot'>('full')
const poseGroups = [
  { key: 'full' as const, poses: ['full-left', 'full-center', 'full-right'] as PoseKey[] },
  { key: 'half' as const, poses: ['half-left', 'half-center', 'half-right'] as PoseKey[] },
  { key: 'headshot' as const, poses: ['headshot-left', 'headshot-center', 'headshot-right'] as PoseKey[] },
]

function setScreenPose(key: PoseKey) {
  controller.setScreenPose(key)
  sendToMain('set-pose', { key })
  for (const g of poseGroups) {
    if (g.poses.includes(key)) { activeScale.value = g.key; break }
  }
}

/** 统计某组合的可用图片数 */
function countImages(pose?: string, emotion?: string, costume?: string): number {
  const data = charStore.data
  if (!data) return 0
  return findImages(data, {
    pose: pose || controller.currentPoseTag.value,
    emotion: emotion || controller.currentEmotion.value,
    costume: costume || controller.currentCostume.value,
  }).length
}

// ---- 姿势（身体） ----
function setStance(stance: string) {
  controller.setPoseTag(stance)
  sendToMain('set-stance', { stance })
}

/** 检查某组合是否有可用图片 */
function hasImage(pose?: string, emotion?: string, costume?: string): boolean {
  const data = charStore.data
  if (!data) return false
  return findImages(data, {
    pose: pose || controller.currentPoseTag.value,
    emotion: emotion || controller.currentEmotion.value,
    costume: costume || controller.currentCostume.value,
  }).length > 0
}

// ---- 服装 ----
function setCostume(costume: string) {
  controller.setCostume(costume)
  sendToMain('set-costume', { costume })
}

// ---- 情绪 ----
function setEmotion(emotion: string) {
  controller.setEmotion(emotion)
  sendToMain('set-emotion', { emotion })
}
</script>

<template>
  <div class="dev-panel" :class="{ 'embedded': !isDevWindow }">
    <!-- === 身体姿势 === -->
    <section class="section">
      <h2 class="section-title"><i class="fas fa-person"></i> {{ t('dev.pose') }}</h2>
      <div class="status-bar">
        <span class="status-label">{{ t('dev.current') }}</span>
        <span class="status-value">{{ controller.currentPoseTag.value || '-' }}</span>
      </div>
      <div class="btn-row">
        <button v-for="p in charStore.poses" :key="p"
          :class="['tag-btn', { active: controller.currentPoseTag.value === p, disabled: !hasImage(p) }]"
          :disabled="!hasImage(p)" @click="setStance(p)">{{ p }}<sup class="cnt" v-if="countImages(p) > 0">{{
            countImages(p) }}</sup></button>
        <span v-if="charStore.poses.length === 0" class="no-data">{{ t('dev.noPose') }}</span>
      </div>
    </section>

    <!-- === 服装 === -->
    <section class="section">
      <h2 class="section-title"><i class="fas fa-shirt"></i> {{ t('dev.costume') }}</h2>
      <div class="status-bar">
        <span class="status-label">{{ t('dev.current') }}</span>
        <span class="status-value">{{ controller.currentCostume.value || '-' }}</span>
      </div>
      <div class="btn-row">
        <button v-for="c in charStore.costumes" :key="c"
          :class="['tag-btn', { active: controller.currentCostume.value === c, disabled: !hasImage(undefined, undefined, c) }]"
          :disabled="!hasImage(undefined, undefined, c)" @click="setCostume(c)">{{ c }}<sup class="cnt"
            v-if="countImages(undefined, undefined, c) > 0">{{ countImages(undefined, undefined, c) }}</sup></button>
        <span v-if="charStore.costumes.length === 0" class="no-data">{{ t('dev.noCostume') }}</span>
      </div>
    </section>

    <!-- === 情绪 === -->
    <section class="section">
      <h2 class="section-title"><i class="fas fa-face-smile"></i> {{ t('dev.emotion') }}</h2>
      <div class="status-bar">
        <span class="status-label">{{ t('dev.current') }}</span>
        <span class="status-value">{{ controller.currentEmotion.value || '-' }}</span>
      </div>
      <div class="emotion-grid">
        <button v-for="e in charStore.emotions" :key="e"
          :class="['tag-btn', { active: controller.currentEmotion.value === e, disabled: !hasImage(undefined, e) }]"
          :disabled="!hasImage(undefined, e)" @click="setEmotion(e)">{{ e }}<sup class="cnt"
            v-if="countImages(undefined, e) > 0">{{ countImages(undefined, e) }}</sup></button>
        <span v-if="charStore.emotions.length === 0" class="no-data">{{ t('dev.noEmotion') }}</span>
      </div>
    </section>

    <!-- === 屏幕姿态 === -->
    <section class="section">
      <h2 class="section-title"><i class="fas fa-display"></i> {{ t('dev.screenPos') }}</h2>
      <div class="status-bar">
        <span class="status-label">{{ t('dev.current') }}</span>
        <span class="status-value">{{ POSE_PRESETS[controller.currentScreenPose.value]?.label ?? '-' }}</span>
      </div>
      <div class="tab-bar">
        <button v-for="g in poseGroups" :key="g.key" :class="['tab', { active: activeScale === g.key }]"
          @click="activeScale = g.key">{{ t('dev.' + g.key) }}</button>
      </div>
      <div class="pose-grid">
        <button v-for="key in (poseGroups.find(g => g.key === activeScale)?.poses ?? [])" :key="key"
          :class="['tag-btn', { active: controller.currentScreenPose.value === key }]" @click="setScreenPose(key)">
          {{ POSE_PRESETS[key].label }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dev-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.dev-panel.embedded {
  background: transparent;
  color: #ccc;
  min-height: auto;
}

.section {
  padding: 12px 0;
  border-bottom: 1px solid #2a2a4a;
}

.section:last-child {
  border-bottom: none;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #888;
  margin: 0 0 8px;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}

.status-label {
  color: #777;
}

.status-value {
  color: #7c8cff;
  font-weight: 500;
}

/* 通用按钮行 */
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-btn {
  padding: 6px 14px;
  font-size: 12px;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.12s;
}

.tag-btn:hover {
  border-color: #7c8cff;
  color: #7c8cff;
  background: rgba(124, 140, 255, 0.1);
}

.tag-btn.active {
  background: rgba(124, 140, 255, 0.15);
  border-color: #7c8cff;
  color: #b0bfff;
  font-weight: 500;
}

.tag-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  border-color: #1e1e38;
  background: #16162a;
  color: #555;
}

.tag-btn:disabled:hover {
  border-color: #1e1e38;
  color: #555;
  background: #16162a;
}

.tag-btn .cnt {
  font-size: 10px;
  color: #7c8cff;
  margin-left: 2px;
  font-weight: 400;
}

.tag-btn:disabled .cnt {
  color: #555;
}

/* 情绪用网格 */
.emotion-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Tab 切换 */
.tab-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
  background: #1e1e38;
  border-radius: 8px;
  padding: 3px;
}

.tab {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  border: none;
  background: transparent;
  color: #777;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
}

.tab.active {
  background: #2a2a4a;
  color: #e0e0e0;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.tab:hover:not(.active) {
  color: #ccc;
}

/* 屏幕姿态网格 */
.pose-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.no-data {
  font-size: 12px;
  color: #555;
  padding: 4px 0;
}
</style>
