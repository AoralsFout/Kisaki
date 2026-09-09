<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  calculateConversationDockLayout,
  type ConversationDockLayout,
} from './conversationDockLayout'

const props = defineProps<{
  expanded: boolean
  latestMessageHeight: number
  layoutKey?: string
}>()

const rootRef = ref<HTMLElement | null>(null)
const beforeRef = ref<HTMLElement | null>(null)
const afterRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLElement | null>(null)
const ready = ref(false)
const settling = ref(false)

const layout = ref<ConversationDockLayout>({
  inputDrop: 0,
  historyHeight: 0,
  expandedHistoryHeight: 0,
  collapsedHistoryHeight: 0,
  latestOverflowing: false,
})

let resizeObserver: ResizeObserver | null = null
let layoutRaf = 0
let readyRaf = 0
let settleRaf = 0

function elementHeight(element: HTMLElement | null): number {
  return element?.getBoundingClientRect().height ?? 0
}

function refreshLayout() {
  layout.value = calculateConversationDockLayout({
    containerHeight: elementHeight(rootRef.value),
    beforeHeight: elementHeight(beforeRef.value),
    afterHeight: elementHeight(afterRef.value),
    inputHeight: elementHeight(inputRef.value),
    latestMessageHeight: props.latestMessageHeight,
    expanded: props.expanded,
  })
}

function scheduleLayout() {
  if (layoutRaf) cancelAnimationFrame(layoutRaf)
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0
    refreshLayout()
  })
}

function observeLayoutElements() {
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(scheduleLayout)
  for (const element of [rootRef.value, beforeRef.value, afterRef.value, inputRef.value]) {
    if (element) resizeObserver.observe(element)
  }
}

onMounted(() => {
  void nextTick(() => {
    refreshLayout()
    observeLayoutElements()
    readyRaf = requestAnimationFrame(() => { ready.value = true })
  })
  window.addEventListener('resize', scheduleLayout)
})

watch(
  () => [props.expanded, props.latestMessageHeight] as const,
  refreshLayout,
  { flush: 'post' },
)

watch(
  () => props.layoutKey,
  (value, previous) => {
    if (!ready.value || value === previous) return
    settling.value = true
    refreshLayout()
    if (settleRaf) cancelAnimationFrame(settleRaf)
    settleRaf = requestAnimationFrame(() => { settling.value = false })
  },
  { flush: 'post' },
)

onUnmounted(() => {
  if (layoutRaf) cancelAnimationFrame(layoutRaf)
  if (readyRaf) cancelAnimationFrame(readyRaf)
  if (settleRaf) cancelAnimationFrame(settleRaf)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', scheduleLayout)
})
</script>

<template>
  <div ref="rootRef" class="conversation-dock" :class="{ 'is-ready': ready, 'is-settling': settling }">
    <div class="dock-track" :style="{ '--input-drop': `${layout.inputDrop}px` }">
      <div class="dock-spacer"></div>

      <div ref="beforeRef" class="dock-before">
        <slot name="before"></slot>
      </div>

      <div class="dock-history" :style="{ '--history-height': `${layout.historyHeight}px` }">
        <slot name="history" :collapsed-height="layout.collapsedHistoryHeight"
          :latest-overflowing="layout.latestOverflowing"></slot>
      </div>

      <div ref="afterRef" class="dock-after">
        <slot name="after"></slot>
      </div>

      <div ref="inputRef" class="dock-input">
        <slot name="input"></slot>
      </div>
    </div>

    <div class="dock-overlay">
      <slot name="overlay"></slot>
    </div>
  </div>
</template>

<style scoped>
.conversation-dock {
  position: absolute;
  inset: 0;
  z-index: 50;
  /* hidden 仍是可编程滚动容器，焦点进入菜单时浏览器可能滚动并露出已收起的输入区。 */
  overflow: hidden;
  overflow: clip;
  pointer-events: none;
}

.dock-track {
  width: 100%;
  height: calc(100% + var(--input-drop, 0px));
  display: flex;
  flex-direction: column;
  align-items: center;
}

.dock-spacer {
  width: 100%;
  min-height: 0;
  flex: 1 1 0;
}

.dock-before,
.dock-after,
.dock-input {
  width: 100%;
  flex: 0 0 auto;
  pointer-events: none;
}

.dock-before,
.dock-after {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.dock-history {
  width: 100%;
  height: var(--history-height, 0px);
  min-height: 0;
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  overflow: hidden;
  pointer-events: auto;
}

.conversation-dock.is-ready .dock-track,
.conversation-dock.is-ready .dock-history {
  transition: height 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.conversation-dock.is-settling .dock-track,
.conversation-dock.is-settling .dock-history {
  transition: none;
}

.dock-input {
  overflow: hidden;
}

.dock-before :deep(> *),
.dock-after :deep(> *),
.dock-input :deep(> *),
.dock-overlay :deep(> *) {
  pointer-events: auto;
}

.dock-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .conversation-dock.is-ready .dock-track,
  .conversation-dock.is-ready .dock-history {
    transition: none;
  }
}

:global(:root[data-reduced-motion='true']) .conversation-dock.is-ready .dock-track,
:global(:root[data-reduced-motion='true']) .conversation-dock.is-ready .dock-history {
  transition: none;
}
</style>
