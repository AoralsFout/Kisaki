<script setup lang="ts">
/**
 * 历史对话列表 —— 常驻底部交互区，取代独立对话气泡
 *
 * - 折叠态（对话框收起）：仅展示最新一条；短消息底部对齐，长消息从顶部预览；
 * - 展开态（对话框弹出）：由 ConversationDock 分配可用高度，列表在内部滚动；
 * - 容器整体为实体区域（data-pet-solid）：背景透明但空隙不穿透——悬停空隙时的
 *   滚轮会转发给消息列表滚动，避免滚动意图被透传到桌面；
 * - 顶部渐隐（mask，仅展开态），提示上方还有更早的历史；
 * - 生成中以「待完成项」实时显示流式回复，完成后并入正式历史；
 * - 助手消息展示角色身份快照名，旧数据回退当前角色名；
 * - 回档控件位于用户气泡头部右侧，生成中锁定。
 */
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { useCharacterStore } from '../character'
import { shouldReduceMotion } from '../utils/motionPreference'
import ImageLightbox from './ImageLightbox.vue'
import { collapsedLatestScrollTop } from './chatHistoryLayout'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible?: boolean
  collapsedHeight?: number
  latestOverflowing?: boolean
}>(), {
  visible: false,
  collapsedHeight: 0,
  latestOverflowing: false,
})

const emit = defineEmits<{
  latestHeightChange: [height: number]
}>()

const chat = useChatStore()
const sessionStore = useSessionStore()
const charStore = useCharacterStore()
const historyRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const previewImage = ref<{ dataUrl: string; name: string } | null>(null)
const sessionSwitching = ref(false)

/** 展开态由对话框驱动；几何过渡统一交给 ConversationDock。 */
const expanded = computed(() => chat.showInput)

let latestResizeObserver: ResizeObserver | null = null
let observedLatestItem: HTMLElement | null = null

/** 助手消息展示名：优先消息内的角色身份快照，旧数据回退当前角色名/品牌名 */
function assistantLabel(charName?: string): string {
  return charName || charStore.name || 'Kisaki'
}

/** 正在二次确认回档的消息 id */
const confirmRollbackId = ref<string | null>(null)

/** 执行回档：还原文件 + 恢复视觉状态 + 截断此后对话 */
async function doRollback(messageId: string) {
  confirmRollbackId.value = null
  await sessionStore.rollbackTo(messageId)
}

/** 是否显示流式回复的待完成项 */
const hasPending = computed(() =>
  chat.isProcessing && Boolean(chat.currentBubbleText || chat.currentThinking),
)

/** 展开态下，悬停在气泡间空隙时把滚轮转发给列表（折叠态不可滚动）。 */
function onWheel(e: WheelEvent) {
  const list = listRef.value
  if (!list || !expanded.value) return
  if (e.target instanceof Node && list.contains(e.target)) return
  list.scrollBy({ top: e.deltaY })
}

function lastHistoryItem(): HTMLElement | null {
  const items = listRef.value?.querySelectorAll<HTMLElement>('.history-item')
  return items?.[items.length - 1] ?? null
}

/** 向布局壳报告最新一条消息的原始高度；可用空间和裁剪统一由布局壳计算。 */
function publishLatestHeight() {
  const last = lastHistoryItem()
  emit('latestHeightChange', last ? Math.ceil(last.getBoundingClientRect().height) : 0)
}

/** 最新项替换时切换观察目标；流式文本、图片和 details 尺寸变化会自动重新发布。 */
function observeLatestItem() {
  const latest = lastHistoryItem()
  if (latestResizeObserver && observedLatestItem !== latest) {
    latestResizeObserver.disconnect()
    if (latest) latestResizeObserver.observe(latest)
  }
  observedLatestItem = latest
  publishLatestHeight()
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    latestResizeObserver = new ResizeObserver(() => {
      publishLatestHeight()
      if (!expanded.value) jumpToLatestNow()
    })
  }
  void nextTick(observeLatestItem)
})

// 对齐最新消息：展开态滚到底；折叠态短消息滚到底、长消息定位到消息顶部。
function collapsedTarget(list: HTMLElement): number {
  const last = lastHistoryItem()
  if (!last) return 0
  const listRect = list.getBoundingClientRect()
  const itemRect = last.getBoundingClientRect()
  return collapsedLatestScrollTop({
    scrollHeight: list.scrollHeight,
    currentScrollTop: list.scrollTop,
    listTop: listRect.top,
    itemTop: itemRect.top,
    itemHeight: itemRect.height,
    viewportHeight: props.collapsedHeight,
  })
}

function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
  const resolvedBehavior = behavior === 'smooth' && shouldReduceMotion() ? 'auto' : behavior
  nextTick(() => {
    const list = listRef.value
    if (!list) return
    list.scrollTo({
      top: expanded.value ? list.scrollHeight : collapsedTarget(list),
      behavior: resolvedBehavior,
    })
  })
}

function jumpToLatestNow() {
  const list = listRef.value
  if (!list) return
  list.scrollTo({
    top: expanded.value ? list.scrollHeight : collapsedTarget(list),
    behavior: 'auto',
  })
}

let sessionSettleVersion = 0
let collapseRaf = 0
let collapsedLayoutRaf = 0

function cancelCollapseScroll() {
  if (collapseRaf) cancelAnimationFrame(collapseRaf)
  collapseRaf = 0
}

/** 折叠态内容尺寸变化后，在浏览器完成本帧布局时重测并重新对齐最新消息。 */
function scheduleCollapsedLayoutRefresh() {
  if (expanded.value || sessionSwitching.value) return
  if (collapsedLayoutRaf) cancelAnimationFrame(collapsedLayoutRaf)
  collapsedLayoutRaf = requestAnimationFrame(() => {
    collapsedLayoutRaf = 0
    observeLatestItem()
    jumpToLatestNow()
  })
}

function onThinkingToggle() {
  scheduleCollapsedLayoutRefresh()
}

/**
 * 会话替换会同时改变末条消息高度和列表 scrollHeight；在 DOM 提交后及下一绘制帧
 * 各校准一次，避免异步布局把位置留在最新消息上方。
 */
async function settleSessionAtLatest() {
  const version = ++sessionSettleVersion
  cancelCollapseScroll()
  sessionSwitching.value = true
  await nextTick()
  if (version !== sessionSettleVersion) return
  observeLatestItem()
  await nextTick()
  if (version !== sessionSettleVersion) return
  jumpToLatestNow()
  requestAnimationFrame(() => {
    if (version !== sessionSettleVersion) return
    jumpToLatestNow()
    sessionSwitching.value = false
  })
}

function onHistoryImageLoad() {
  if (expanded.value && !sessionSwitching.value) return
  void nextTick(async () => {
    observeLatestItem()
    await nextTick()
    jumpToLatestNow()
  })
}

onUnmounted(() => {
  sessionSettleVersion++
  cancelCollapseScroll()
  if (collapsedLayoutRaf) cancelAnimationFrame(collapsedLayoutRaf)
  collapsedLayoutRaf = 0
  latestResizeObserver?.disconnect()
  latestResizeObserver = null
  observedLatestItem = null
})

// 首次载入与每次切换会话都瞬时定位；仅同一会话内的新消息使用平滑滚动。
let initialMessagesSettled = false
let lastSessionId = sessionStore.currentSessionId
watch(
  () => [sessionStore.currentSessionId, chat.messages.length, hasPending.value] as const,
  ([sessionId]) => {
    const sessionChanged = sessionId !== lastSessionId
    lastSessionId = sessionId
    if (!props.visible) return
    void nextTick(observeLatestItem)
    if (sessionChanged) void settleSessionAtLatest()
    else scrollToLatest(!initialMessagesSettled ? 'auto' : 'smooth')
    initialMessagesSettled = true
  },
  { immediate: true },
)
watch(
  () => [chat.currentBubbleText.length, chat.currentThinking.length] as const,
  () => {
    if (!props.visible) return
    if (expanded.value) scrollToLatest('auto')
    else scheduleCollapsedLayoutRefresh()
  },
)
watch(
  () => props.visible,
  (v) => { if (v) scrollToLatest('auto') },
  { immediate: true },
)
watch(
  () => props.collapsedHeight,
  () => {
    if (!expanded.value && props.visible) void nextTick(jumpToLatestNow)
  },
)
/** 收起：滚动位置与视口高度同步移向最新消息，保留从历史中部收起时的连续感。 */
function collapseToLatestAnimated() {
  const list = listRef.value
  if (!list) return
  const startScroll = list.scrollTop
  const endScroll = collapsedTarget(list)
  if (Math.abs(endScroll - startScroll) <= 1) return
  cancelCollapseScroll()
  const duration = 350
  const startTime = performance.now()
  const tick = (now: number) => {
    const p = Math.min((now - startTime) / duration, 1)
    list.scrollTop = startScroll + (endScroll - startScroll) * p
    if (p < 1) collapseRaf = requestAnimationFrame(tick)
    else collapseRaf = 0
  }
  collapseRaf = requestAnimationFrame(tick)
}

watch(expanded, async (v) => {
  await nextTick()
  const list = listRef.value
  if (!list) return
  if (sessionSwitching.value || shouldReduceMotion()) {
    jumpToLatestNow()
    return
  }
  if (v) jumpToLatestNow()
  else collapseToLatestAnimated()
})
</script>

<template>
  <ImageLightbox :visible="Boolean(previewImage)" :src="previewImage?.dataUrl"
    :alt="previewImage?.name" @close="previewImage = null" />
  <div v-if="visible" ref="historyRef"
    :class="['chat-history', { expanded, 'session-switching': sessionSwitching, 'latest-overflowing': latestOverflowing }]"
    data-pet-solid @wheel="onWheel">
    <div ref="listRef" class="message-list">
      <div v-for="msg in chat.messages" :key="msg.id" class="history-item">
        <!-- 头部：角色/时间 + 回档（用户消息） -->
        <div class="item-header">
          <div class="msg-role-label">
            {{ msg.role === 'user' ? t('chat.history.you') : assistantLabel(msg.charName) }}
            <span class="msg-time">{{ new Date(msg.timestamp).toLocaleString() }}</span>
          </div>
          <div v-if="msg.role === 'user'" class="msg-rollback">
            <template v-if="confirmRollbackId === msg.id">
              <span class="rb-q">{{ t('chat.history.rollbackConfirm') }}</span>
              <button class="rb-yes" @click="doRollback(msg.id)">{{ t('chat.history.rollbackYes') }}</button>
              <button class="rb-no" @click="confirmRollbackId = null">{{ t('common.cancel') }}</button>
            </template>
            <button v-else class="rb-btn" :disabled="chat.isProcessing" :title="t('chat.history.rollbackTitle')"
              :aria-label="t('chat.history.rollbackTitle')"
              @click="confirmRollbackId = msg.id">
              <i class="fas fa-clock-rotate-left"></i> {{ t('chat.history.rollback') }}
            </button>
          </div>
        </div>
        <!-- 思考内容（仅 assistant 消息可能有） -->
        <details v-if="msg.thinking" class="thinking-block" @toggle="onThinkingToggle">
          <summary class="thinking-summary">{{ t('chat.history.thinking') }}</summary>
          <div class="thinking-text" data-selectable>{{ msg.thinking }}</div>
        </details>
        <div v-if="msg.images?.length" class="msg-images">
          <button v-for="image in msg.images" :key="image.id" type="button" class="msg-image-button"
            :aria-label="t('chat.history.openImage', { name: image.name })"
            @click="previewImage = image">
            <img :src="image.dataUrl" :alt="image.name" @load="onHistoryImageLoad" />
          </button>
        </div>
        <div class="msg-text" data-selectable>{{ msg.text }}</div>
      </div>

      <!-- 流式回复的待完成项：生成中实时显示，完成后并入正式历史 -->
      <div v-if="hasPending" class="history-item pending">
        <div class="item-header">
          <div class="msg-role-label">{{ assistantLabel() }}</div>
        </div>
        <details v-if="chat.currentThinking" class="thinking-block" @toggle="onThinkingToggle">
          <summary class="thinking-summary">{{ t('chat.history.thinking') }}</summary>
          <div class="thinking-text" data-selectable>{{ chat.currentThinking }}</div>
        </details>
        <div class="msg-text" data-selectable>{{ chat.currentBubbleText }}<span v-if="chat.isTyping" class="pending-cursor">▌</span></div>
      </div>
    </div>
    <button v-if="latestOverflowing && !expanded" type="button" class="collapsed-more"
      :aria-label="t('chat.history.expandMessage')" data-pet-solid @click.stop="chat.openInput">
      <span>{{ t('chat.history.expandMessage') }}</span>
      <i class="fas fa-chevron-up" aria-hidden="true"></i>
    </button>
  </div>
</template>

<style scoped>
.chat-history {
  position: relative;
  width: 100%;
  height: 100%;
  max-width: 600px;
  min-height: 0;
  /* 容器整体为实体区域：背景透明但空隙不穿透，悬停空隙的滚轮转发给列表滚动 */
  background: transparent;
}

.chat-history.latest-overflowing:not(.expanded)::after {
  content: '';
  position: absolute;
  z-index: 1;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 54px;
  border-radius: 0 0 var(--radius-card) var(--radius-card);
  background: linear-gradient(to bottom, transparent, var(--c-bubble-light) 72%);
  pointer-events: none;
}

.collapsed-more {
  position: absolute;
  z-index: 2;
  right: 18px;
  bottom: 7px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: var(--radius-control);
  padding: 3px 8px;
  background: rgba(255, 255, 255, 0.72);
  color: rgba(0, 0, 0, 0.62);
  font-size: var(--fs-aux);
  cursor: pointer;
}

.collapsed-more:hover,
.collapsed-more:focus-visible {
  color: rgba(0, 0, 0, 0.82);
  background: rgba(255, 255, 255, 0.9);
}

.message-list {
  /* 行高约束列表高度：折叠态溢出隐藏不可滚动，展开态内部滚动；
     收起/展开时由脚本瞬时滚到底，保证始终显示最新消息。
     内容贴底用首项 margin-top:auto 实现：空间富余时贴底（消息少时紧跟工具栏）；
     溢出时 auto 边距归零、内容顶部对齐且可正常滚动（justify-content: flex-end 在
     溢出的滚动容器里会把溢出压到起点上方导致无法滚动，不能用） */
  min-height: 0;
  height: 100%;
  box-sizing: border-box;
  overflow-y: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 44px;
  margin: 0px 8px;

  border-radius: var(--radius-card);
}

.message-list > :first-child {
  margin-top: auto;
}

/* 展开态：全高可滚动，顶部渐隐提示上方还有更早的历史（折叠态不渐隐） */
.chat-history.expanded .message-list {
  overflow-y: auto;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 52px);
  mask-image: linear-gradient(to bottom, transparent 0, #000 52px);
}

.message-list::-webkit-scrollbar {
  width: 4px;
}

.message-list::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 4px;
}

/* ---- 单条消息：单列占满宽度的浅色气泡 ---- */
.history-item {
  background: var(--c-bubble-light);
  color: #333;
  border-radius: var(--radius-card);
  padding: 10px 14px;
  word-break: break-word;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}

/* 流式回复的待完成项 */
.pending .msg-text {
  min-height: 1.6em;
}

.pending-cursor {
  animation: pending-blink 0.8s step-end infinite;
  color: rgba(0, 0, 0, 0.4);
  font-weight: bold;
}

@keyframes pending-blink {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0;
  }
}

/* ---- 气泡头部：角色/时间 + 回档 ---- */
.item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.msg-role-label {
  font-size: var(--fs-aux);
  color: rgba(0, 0, 0, 0.68);
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.msg-time {
  font-size: var(--fs-aux);
  color: rgba(0, 0, 0, 0.58);
}

.msg-images {
  /* 多图自适应换行，窄窗口不裁切 */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 6px;
  margin-bottom: 7px;
  max-width: 280px;
}

.msg-image-button {
  min-width: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: var(--radius-control);
  background: rgba(0, 0, 0, 0.04);
  cursor: zoom-in;
}

.msg-image-button img {
  display: block;
  width: 100%;
  max-height: 120px;
  object-fit: cover;
}

.msg-text {
  font-size: var(--fs-body);
  line-height: 1.6;
  white-space: pre-wrap;
}

/* ---- 回档控件（用户消息，头部右侧） ---- */
.msg-rollback {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  flex-shrink: 0;
}

.rb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--fs-aux);
  color: rgba(0, 0, 0, 0.58);
  padding: 2px 4px;
  border-radius: 6px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.history-item:hover .rb-btn,
.history-item:focus-within .rb-btn {
  opacity: 1;
}

.rb-btn:hover:not(:disabled) {
  color: var(--c-warn);
  background: rgba(255, 167, 38, 0.12);
}

.rb-btn:disabled {
  cursor: not-allowed;
}

.rb-q {
  font-size: var(--fs-aux);
  color: rgba(0, 0, 0, 0.7);
}

.rb-yes,
.rb-no {
  font-size: var(--fs-aux);
  border: none;
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
}

.rb-yes {
  background: rgba(255, 167, 38, 0.85);
  color: #2a2030;
  font-weight: 600;
}

.rb-yes:hover {
  background: var(--c-warn);
}

.rb-no {
  background: rgba(0, 0, 0, 0.08);
  color: rgba(0, 0, 0, 0.7);
}

.rb-no:hover {
  background: rgba(0, 0, 0, 0.15);
}

/* ---- 思考内容 ---- */
.thinking-block {
  margin: 4px 0 6px;
  font-size: var(--fs-aux);
}

.thinking-summary {
  color: rgba(0, 0, 0, 0.62);
  font-style: italic;
  cursor: pointer;
  user-select: none;
  font-size: var(--fs-aux);
}

.thinking-summary::-webkit-details-marker {
  color: rgba(0, 0, 0, 0.3);
}

.thinking-text {
  margin-top: 3px;
  color: rgba(0, 0, 0, 0.68);
  font-style: italic;
  line-height: 1.5;
  white-space: pre-wrap;
  font-size: var(--fs-aux);
}

</style>
