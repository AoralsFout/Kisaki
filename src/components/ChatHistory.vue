<script setup lang="ts">
/**
 * 历史对话列表 —— 常驻底部交互区，取代独立对话气泡
 *
 * - 折叠态（对话框收起）：仅展开一条消息的高度、不可滚动，底部锚定显示最新回复；
 * - 展开态（对话框弹出）：生长到全高并可滚动，展开/收起在同一元素上过渡，动画连贯；
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

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible?: boolean
}>(), {
  visible: false,
})

const chat = useChatStore()
const sessionStore = useSessionStore()
const charStore = useCharacterStore()
const historyRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const previewImage = ref<{ dataUrl: string; name: string } | null>(null)
const sessionSwitching = ref(false)

/** 展开态由对话框驱动；折叠/展开在同一元素上过渡 */
const expanded = computed(() => chat.showInput)

/** 挂载后下一帧再置位，让折叠高度从 0 过渡生长（入场动画） */
const entered = ref(false)
onMounted(() => {
  requestAnimationFrame(() => { entered.value = true })
})

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

/** 悬停在气泡间空隙时的滚轮转发给列表滚动（列表自身滚动由浏览器原生处理） */
function onWheel(e: WheelEvent) {
  const list = listRef.value
  if (!list) return
  if (e.target instanceof Node && list.contains(e.target)) return
  list.scrollBy({ top: e.deltaY })
}

/**
 * 折叠高度 = 最新一条消息的实际高度（上限 220px，过长时裁剪只露尾部），
 * 保证折叠态恰好只展开一条对话。
 */
const collapsedHeight = ref(0)
function measureCollapsed() {
  const list = listRef.value
  if (!list) return
  const items = list.querySelectorAll<HTMLElement>('.history-item')
  const last = items[items.length - 1]
  const padBottom = parseFloat(getComputedStyle(list).paddingBottom) || 0
  const h = last ? last.getBoundingClientRect().height + padBottom : 0
  collapsedHeight.value = Math.min(Math.ceil(h), 220)
}
watch(
  () => [sessionStore.currentSessionId, chat.messages.length, hasPending.value, expanded.value] as const,
  () => { nextTick(measureCollapsed) },
  { immediate: true },
)

// 滚到底部：新消息与流式增量平滑滚动；展开/收起与首启首次载入瞬时定位
function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  const resolvedBehavior = behavior === 'smooth' && shouldReduceMotion() ? 'auto' : behavior
  nextTick(() => {
    listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior: resolvedBehavior })
  })
}

function jumpToBottomNow() {
  const list = listRef.value
  if (!list) return
  list.scrollTo({ top: list.scrollHeight, behavior: 'auto' })
}

let sessionSettleVersion = 0
let collapseRaf = 0

function cancelCollapseScroll() {
  if (collapseRaf) cancelAnimationFrame(collapseRaf)
  collapseRaf = 0
}

/**
 * 会话替换会同时改变末条消息高度和列表 scrollHeight。先禁用行高过渡并重测折叠高度，
 * 再在新高度提交后及下一绘制帧各校准一次，避免布局钳制把位置留在底部上方。
 */
async function settleSessionAtBottom() {
  const version = ++sessionSettleVersion
  cancelCollapseScroll()
  sessionSwitching.value = true
  await nextTick()
  if (version !== sessionSettleVersion) return
  measureCollapsed()
  await nextTick()
  if (version !== sessionSettleVersion) return
  jumpToBottomNow()
  requestAnimationFrame(() => {
    if (version !== sessionSettleVersion) return
    jumpToBottomNow()
    sessionSwitching.value = false
  })
}

function onHistoryImageLoad() {
  if (expanded.value && !sessionSwitching.value) return
  void nextTick(async () => {
    measureCollapsed()
    await nextTick()
    jumpToBottomNow()
  })
}

onUnmounted(() => {
  sessionSettleVersion++
  cancelCollapseScroll()
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
    if (sessionChanged) void settleSessionAtBottom()
    else scrollToBottom(!initialMessagesSettled ? 'auto' : 'smooth')
    initialMessagesSettled = true
  },
)
watch(
  () => chat.currentBubbleText.length,
  () => { if (props.visible && expanded.value) scrollToBottom('auto') },
)
watch(
  () => props.visible,
  (v) => { if (v) scrollToBottom('auto') },
  { immediate: true },
)
// 折叠/展开切换：行高过渡会不断改变列表的可滚动量，
// 只在过渡结束时校准会出现"结束瞬间跳到正确位置"的跳变；
// 过渡期间逐帧把 scrollTop 钳到当前最大值，全程钉在底部则无跳变
function pinToBottomDuringTransition() {
  const container = historyRef.value
  const list = listRef.value
  if (!container || !list) return
  if (shouldReduceMotion()) return
  const box: HTMLElement = container
  const scroller: HTMLElement = list
  let raf = 0
  const tick = () => {
    scroller.scrollTop = scroller.scrollHeight
    raf = requestAnimationFrame(tick)
  }
  function finish(e?: TransitionEvent) {
    if (e && (e.target !== box || e.propertyName !== 'grid-template-rows')) return
    clearTimeout(timeout)
    box.removeEventListener('transitionend', finish)
    box.removeEventListener('transitioncancel', finish)
    cancelAnimationFrame(raf)
    scrollToBottom('auto')
  }
  const timeout = setTimeout(() => finish(), 1000) // 兜底：transition 事件丢失时终止循环
  raf = requestAnimationFrame(tick)
  box.addEventListener('transitionend', finish)
  box.addEventListener('transitioncancel', finish)
}
/** 收起：scrollTop 与行高过渡同步插值下滑到最新消息——
    起点直接钳到终点会在收起开始瞬间瞬移；与行高过渡同进度插值则窗口连续变化，无跳变 */
function collapseToBottomAnimated() {
  const list = listRef.value
  if (!list) return
  const contentH = list.scrollHeight
  const startScroll = list.scrollTop
  const endScroll = Math.max(contentH - collapsedHeight.value, startScroll)
  if (endScroll - startScroll <= 1) return // 已在底部，无需补偿动画
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

watch(expanded, (v) => {
  const list = listRef.value
  if (!list) return
  if (sessionSwitching.value || shouldReduceMotion()) {
    jumpToBottomNow() // 会话切换/无过渡：直接定位
    return
  }
  if (v) pinToBottomDuringTransition()
  else collapseToBottomAnimated()
  // 过渡结束校准（消除插值与 CSS 行高过渡的微小舍入差）
  const box = historyRef.value
  if (box) box.addEventListener('transitionend', () => scrollToBottom('auto'), { once: true })
})
</script>

<template>
  <ImageLightbox :visible="Boolean(previewImage)" :src="previewImage?.dataUrl"
    :alt="previewImage?.name" @close="previewImage = null" />
  <div v-if="visible" ref="historyRef" :class="['chat-history', { expanded, entered, 'session-switching': sessionSwitching }]"
    :style="{ '--collapsed-h': `${collapsedHeight}px` }" data-pet-solid @wheel="onWheel">
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
        <details v-if="msg.thinking" class="thinking-block">
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
        <details v-if="chat.currentThinking" class="thinking-block">
          <summary class="thinking-summary">{{ t('chat.history.thinking') }}</summary>
          <div class="thinking-text" data-selectable>{{ chat.currentThinking }}</div>
        </details>
        <div class="msg-text" data-selectable>{{ chat.currentBubbleText }}<span v-if="chat.isTyping" class="pending-cursor">▌</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-history {
  position: relative;
  width: 100%;
  max-width: 600px;
  /* 容器整体为实体区域：背景透明但空隙不穿透，悬停空隙的滚轮转发给列表滚动 */
  background: transparent;
  /* 折叠/展开用 grid 行高过渡：0 → 一条消息高度 → 全高，在同一元素上连贯动画。
     不用 flex-end 钉底：overflow 容器里 flex-end 会被 Chromium 按"安全对齐"回退成顶部对齐；
     列表自身始终保持为滚动容器（见 .message-list），程序化滚到底在两种状态下都可靠。 */
  display: grid;
  grid-template-rows: 0px;
  transition: grid-template-rows 0.35s ease;
}

/* 折叠态：仅最新一条消息的高度（动态量测） */
.chat-history.entered {
  grid-template-rows: var(--collapsed-h, 220px);
}

/* 展开态：对话框弹出时生长到全高 */
.chat-history.expanded {
  grid-template-rows: 45vh;
}

.chat-history.session-switching {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .chat-history {
    transition: none;
  }
}

.message-list {
  /* 行高约束列表高度：折叠态溢出隐藏不可滚动，展开态内部滚动；
     收起/展开时由脚本瞬时滚到底，保证始终显示最新消息。
     内容贴底用首项 margin-top:auto 实现：空间富余时贴底（消息少时紧跟工具栏）；
     溢出时 auto 边距归零、内容顶部对齐且可正常滚动（justify-content: flex-end 在
     溢出的滚动容器里会把溢出压到起点上方导致无法滚动，不能用） */
  min-height: 0;
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

@media (max-height: 520px) {
  .chat-history.expanded { grid-template-rows: 32vh; }
}
</style>
