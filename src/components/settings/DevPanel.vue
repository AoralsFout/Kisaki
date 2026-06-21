<script setup lang="ts">
/**
 * 开发者调试面板
 *
 * 支持立绘和 Live2D 角色调试。通过 BroadcastChannel 向主窗口发指令。
 *
 * Bug 修复：不依赖 charStore.currentId（会被设置窗口的角色管理改变），
 * 而是在挂载时 snapshot 当前角色 ID，之后读取独立加载的角色数据来填充 UI。
 * 当前实时状态（情绪/姿势等）由主窗口通过 state-update 消息同步。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { POSE_PRESETS, loadCharacterJson, loadLive2DManifest, useCharacterStore } from '../../character'
import type { PoseKey, CharacterData, Live2DManifest } from '../../character'
import { createLogger } from '../../utils/logger'
import { CHANNEL_DESKPET_DEV } from '../../constants'

const log = createLogger('DevPanel')
const { t } = useI18n()
const charStore = useCharacterStore()

// ── BroadcastChannel（向主窗口发指令） ──
let devChannel: BroadcastChannel | null = null
try { devChannel = new BroadcastChannel(CHANNEL_DESKPET_DEV) } catch { }

function sendToMain(type: string, payload: any) {
  devChannel?.postMessage({ type, payload })
}

// ── 窗口状态 ──
const isDevWindow = ref(false)
const selfWindow = ref<WebviewWindow | null>(null)

// ── 调试角色（从主窗口 state-update 获取，不受设置窗口 charStore 影响） ──
const mainCharId = ref('')
const devCharData = ref<CharacterData | null>(null)
const isLive2d = computed(() => devCharData.value?.render === 'live2d')
const isIllustration = computed(() => !isLive2d.value)
const stateSynced = ref(false) // 是否已收到主窗口状态同步

// 当前状态（由主窗口 state-update 消息更新）
const currentPoseTag = ref('')
const currentEmotion = ref('')
const currentCostume = ref('')
const currentScreenPose = ref<PoseKey>('full-center')

// Live2D manifest
const l2dManifest = ref<Live2DManifest | null>(null)
const currentExpression = ref('')

// ── 屏幕姿态分组 ──
const activeScale = ref<'full' | 'half' | 'headshot'>('full')
const poseGroups = [
  { key: 'full' as const, poses: ['full-left', 'full-center', 'full-right'] as PoseKey[] },
  { key: 'half' as const, poses: ['half-left', 'half-center', 'half-right'] as PoseKey[] },
  { key: 'headshot' as const, poses: ['headshot-left', 'headshot-center', 'headshot-right'] as PoseKey[] },
]

function setScreenPose(key: PoseKey) {
  sendToMain('set-pose', { key })
  currentScreenPose.value = key
  for (const g of poseGroups) {
    if (g.poses.includes(key)) { activeScale.value = g.key; break }
  }
}

/** 根据主窗口的角色 ID 加载数据 */
async function loadMainCharData(id: string) {
  mainCharId.value = id
  devCharData.value = null
  l2dManifest.value = null
  if (!id) return
  try {
    const data = await loadCharacterJson(id)
    devCharData.value = data
    if (data?.render === 'live2d' && data.live2d) {
      l2dManifest.value = await loadLive2DManifest(id, data)
    }
    log.info('调试角色已加载: %s', id)
  } catch (e) {
    log.warn('调试角色加载失败: %s', (e as Error).message)
  }
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  isDevWindow.value = params.has('dev')
  if (isDevWindow.value) {
    selfWindow.value = getCurrentWebviewWindow()
  }

  log.info('DevPanel 挂载 %s', isDevWindow.value ? '(独立窗口)' : '(嵌入式)')

  // 监听主窗口发来的状态更新（含 currentId：主窗口当前角色 ID）
  devChannel?.addEventListener('message', (event) => {
    const { type, payload } = event.data ?? {}
    if (type === 'state-update' && payload) {
      handleStateUpdate(payload)
    }
  })

  // 请求主窗口同步当前状态
  sendToMain('request-state', {})

  // 兜底：1 秒内未收到主窗口响应（如嵌入式 dev 模式无 BroadcastChannel 监听者时）
  // 退而读本地 charStore 的内容（至少让面板有东西可显示）
  setTimeout(() => {
    if (!stateSynced.value) {
      log.warn('未收到主窗口状态同步，回退到本地 charStore')
      const id = charStore.currentId
      if (id) {
        void loadMainCharData(id)
        currentPoseTag.value = charStore.data?.emotions?.[0] ?? ''
        currentEmotion.value = charStore.data?.emotions?.[0] ?? ''
        currentCostume.value = charStore.data?.costumes?.[0] ?? ''
        currentScreenPose.value = 'full-center'
        stateSynced.value = true
      }
    }
  }, 1500)
})

function handleStateUpdate(payload: any) {
  // 先同步角色 ID：从主窗口获取其当前角色，而非读本地 charStore
  if (payload.currentId && payload.currentId !== mainCharId.value) {
    void loadMainCharData(payload.currentId)
  }
  if (payload.poseTag !== undefined) currentPoseTag.value = payload.poseTag
  if (payload.emotion !== undefined) currentEmotion.value = payload.emotion
  if (payload.costume !== undefined) currentCostume.value = payload.costume
  if (payload.screenPose !== undefined) currentScreenPose.value = payload.screenPose
  if (payload.expression !== undefined) currentExpression.value = payload.expression
  stateSynced.value = true
}

onUnmounted(() => {
  // 独立窗口无 controller 要 dispose（全部走 BroadcastChannel）
})

// ── 立绘控制 ──
function setStance(stance: string) {
  sendToMain('set-stance', { stance })
  currentPoseTag.value = stance
}

function setCostume(costume: string) {
  sendToMain('set-costume', { costume })
  currentCostume.value = costume
}

function setEmotion(emotion: string) {
  sendToMain('set-emotion', { emotion })
  currentEmotion.value = emotion
}

// ── Live2D 控制 ──
function setExpression(id: string) {
  sendToMain('set-expression', { expression: id })
  currentExpression.value = id
}

function playMotion(group: string) {
  sendToMain('play-motion', { group, index: 0 })
}

/** 统计某组合的可用图片数（立绘） */
function countImages(pose?: string, emotion?: string, costume?: string): number {
  const data = devCharData.value
  if (!data?.images) return 0
  return data.images.filter(img => {
    if (pose && img.pose !== pose) return false
    if (emotion && !img.emotions.includes(emotion)) return false
    if (costume && img.costume !== costume) return false
    return true
  }).length
}

/** 检查某组合是否有可用图片（立绘） */
function hasImage(pose?: string, emotion?: string, costume?: string): boolean {
  return countImages(pose, emotion, costume) > 0
}
</script>

<template>
  <div class="dev-panel" :class="{ 'embedded': !isDevWindow }">
    <div v-if="!stateSynced" class="loading-msg">{{ t('dev.loading') }}</div>
    <div v-else-if="!devCharData" class="loading-msg">{{ t('dev.noChar') }}</div>
    <template v-else>
    <!-- ====== 立绘调试 ====== -->
    <template v-if="isIllustration">
      <!-- 身体姿势 -->
      <section class="section">
        <h2 class="section-title"><i class="fas fa-person"></i> {{ t('dev.pose') }}</h2>
        <div class="status-bar">
          <span class="status-label">{{ t('dev.current') }}</span>
          <span class="status-value">{{ currentPoseTag || '-' }}</span>
        </div>
        <div class="btn-row">
          <button v-for="p in (devCharData?.poses ?? [])" :key="p"
            :class="['tag-btn', { active: currentPoseTag === p, disabled: !hasImage(p) }]"
            :disabled="!hasImage(p)" @click="setStance(p)">{{ p }}
            <sup class="cnt" v-if="countImages(p) > 0">{{ countImages(p) }}</sup>
          </button>
          <span v-if="!devCharData?.poses?.length" class="no-data">{{ t('dev.noPose') }}</span>
        </div>
      </section>

      <!-- 服装 -->
      <section class="section">
        <h2 class="section-title"><i class="fas fa-shirt"></i> {{ t('dev.costume') }}</h2>
        <div class="status-bar">
          <span class="status-label">{{ t('dev.current') }}</span>
          <span class="status-value">{{ currentCostume || '-' }}</span>
        </div>
        <div class="btn-row">
          <button v-for="c in (devCharData?.costumes ?? [])" :key="c"
            :class="['tag-btn', { active: currentCostume === c, disabled: !hasImage(undefined, undefined, c) }]"
            :disabled="!hasImage(undefined, undefined, c)" @click="setCostume(c)">{{ c }}
            <sup class="cnt" v-if="countImages(undefined, undefined, c) > 0">{{ countImages(undefined, undefined, c) }}</sup>
          </button>
          <span v-if="!devCharData?.costumes?.length" class="no-data">{{ t('dev.noCostume') }}</span>
        </div>
      </section>

      <!-- 情绪 -->
      <section class="section">
        <h2 class="section-title"><i class="fas fa-face-smile"></i> {{ t('dev.emotion') }}</h2>
        <div class="status-bar">
          <span class="status-label">{{ t('dev.current') }}</span>
          <span class="status-value">{{ currentEmotion || '-' }}</span>
        </div>
        <div class="emotion-grid">
          <button v-for="e in (devCharData?.emotions ?? [])" :key="e"
            :class="['tag-btn', { active: currentEmotion === e, disabled: !hasImage(undefined, e) }]"
            :disabled="!hasImage(undefined, e)" @click="setEmotion(e)">{{ e }}
            <sup class="cnt" v-if="countImages(undefined, e) > 0">{{ countImages(undefined, e) }}</sup>
          </button>
          <span v-if="!devCharData?.emotions?.length" class="no-data">{{ t('dev.noEmotion') }}</span>
        </div>
      </section>
    </template>

    <!-- ====== Live2D 调试 ====== -->
    <template v-if="isLive2d">
      <!-- 表情 -->
      <section class="section">
        <h2 class="section-title"><i class="fas fa-face-grin-stars"></i> {{ t('dev.expression') }}</h2>
        <div class="status-bar">
          <span class="status-label">{{ t('dev.current') }}</span>
          <span class="status-value">{{ currentExpression || t('dev.defaultExpr') }}</span>
        </div>
        <div class="emotion-grid">
          <button v-for="e in (l2dManifest?.expressions ?? [])" :key="e.id"
            :class="['tag-btn', { active: currentExpression === e.id }]"
            @click="setExpression(e.id)">{{ e.desc || e.id }}
          </button>
          <span v-if="!l2dManifest?.expressions?.length" class="no-data">{{ t('dev.noExpression') }}</span>
        </div>
      </section>

      <!-- 动作 -->
      <section class="section">
        <h2 class="section-title"><i class="fas fa-film"></i> {{ t('dev.motion') }}</h2>
        <div class="btn-row">
          <button v-for="m in (l2dManifest?.motions ?? [])" :key="m.group"
            class="tag-btn" @click="playMotion(m.group)">
            {{ m.desc || m.group }} <sup class="cnt">{{ m.count }}</sup>
          </button>
          <span v-if="!l2dManifest?.motions?.length" class="no-data">{{ t('dev.noMotion') }}</span>
        </div>
      </section>
    </template>

    <!-- ====== 共享：屏幕姿态 ====== -->
    <section class="section">
      <h2 class="section-title"><i class="fas fa-display"></i> {{ t('dev.screenPos') }}</h2>
      <div class="status-bar">
        <span class="status-label">{{ t('dev.current') }}</span>
        <span class="status-value">{{ POSE_PRESETS[currentScreenPose]?.label ?? '-' }}</span>
      </div>
      <div class="tab-bar">
        <button v-for="g in poseGroups" :key="g.key" :class="['tab', { active: activeScale === g.key }]"
          @click="activeScale = g.key">{{ t('dev.' + g.key) }}</button>
      </div>
      <div class="pose-grid">
        <button v-for="key in (poseGroups.find(g => g.key === activeScale)?.poses ?? [])" :key="key"
          :class="['tag-btn', { active: currentScreenPose === key }]" @click="setScreenPose(key)">
          {{ POSE_PRESETS[key].label }}
        </button>
      </div>
    </section>
    </template>
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

.status-label { color: #777; }
.status-value { color: #7c8cff; font-weight: 500; }

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

.tag-btn:disabled .cnt { color: #555; }

.emotion-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

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

.tab:hover:not(.active) { color: #ccc; }

.pose-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.no-data, .loading-msg {
  font-size: 12px;
  color: #555;
  padding: 4px 0;
}
</style>
