<script setup lang="ts">
/**
 * 对话气泡组件
 *
 * - 非流式模式：缓冲完整文本后，以打字机动画逐字显示
 * - typing=true：打字机动画
 * - typing=false：直接显示完整文本
 * - 打字速度可在设置面板中调整（localStorage: deskpet-typing-speed）
 */
import { computed, ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getTypingSpeed } from '../stores/language'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  text?: string
  thinking?: string
  typing?: boolean
  visible?: boolean
  /** 气泡配色变体：light 浅色（默认，复杂壁纸上可读）；dark 稳定深底 */
  variant?: 'light' | 'dark'
}>(), {
  text: '',
  thinking: '',
  typing: false,
  visible: false,
  variant: 'light',
})

const emit = defineEmits<{
  'typing-end': []
}>()

const displayText = ref('')
const isAnimating = ref(false)
let typingTimer: ReturnType<typeof setInterval> | null = null

/** 长回复判断：超过约 6 行（≈140 字符或 6 个换行）时提供展开能力 */
const LINE_BREAK = String.fromCharCode(10)
const isLong = computed(() => displayText.value.length > 140 || displayText.value.split(LINE_BREAK).length > 6)
const expanded = ref(false)

function toggleExpand() {
  if (isLong.value && !isAnimating.value) expanded.value = !expanded.value
}

/** 气泡点击：打字中=跳过动画；否则长回复时切换展开 */
function onBubbleClick() {
  if (isAnimating.value) { skipTyping(); return }
  toggleExpand()
}

function cleanupTimer() {
  if (typingTimer !== null) {
    clearInterval(typingTimer)
    typingTimer = null
  }
}

function startTypewriter(fullText: string) {
  cleanupTimer()
  displayText.value = ''
  isAnimating.value = true

  const speed = getTypingSpeed()
  // 按 Unicode 码位遍历，避免 emoji / 代理对在动画中闪烁（UTF-16 码元会拆开）
  const chars = [...fullText]
  let index = 0

  typingTimer = setInterval(() => {
    if (index < chars.length) {
      displayText.value += chars[index]
      index++
    } else {
      cleanupTimer()
      isAnimating.value = false
      emit('typing-end')
    }
  }, speed)
}

watch(
  () => props.text,
  (newText) => {
    cleanupTimer()
    isAnimating.value = false
    expanded.value = false

    const text = newText ?? ''
    if (!text) {
      displayText.value = ''
      return
    }

    if (!props.typing) {
      // 固定模式：直接显示完整文本
      displayText.value = text
      emit('typing-end')
    } else {
      // 打字机模式：逐字动画
      startTypewriter(text)
    }
  },
)

/** 跳过打字/直接显示完整文本 */
function skipTyping() {
  cleanupTimer()
  isAnimating.value = false
  displayText.value = props.text
  emit('typing-end')
}

onUnmounted(cleanupTimer)

defineExpose({ skipTyping })
</script>

<template>
  <div v-show="visible" class="bubble-wrapper" data-pet-solid>
    <div :class="['bubble-body', variant, { expanded }]" @click="onBubbleClick">
      <!-- 思考内容（灰色斜体，折叠样式） -->
      <details v-if="thinking" class="thinking-block" @click.stop>
        <summary class="thinking-summary">{{ t('chat.bubble.thinking') }}</summary>
        <div class="thinking-text">{{ thinking }}</div>
      </details>

      <!-- 主文本 -->
      <span class="bubble-text">{{ displayText }}</span>

      <!-- 光标（打字机动画中） -->
      <span v-if="isAnimating" class="cursor">▌</span>

      <!-- 长回复展开/收起 -->
      <button v-if="isLong && !isAnimating" class="bubble-toggle" @click.stop="toggleExpand"
        :aria-expanded="expanded" :title="expanded ? t('chat.bubble.collapse') : t('chat.bubble.expand')">
        <i class="fas" :class="expanded ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.bubble-wrapper {
  max-width: 600px;
  min-width: 200px;
  margin-bottom: 8px;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.25));
}

.bubble-body {
  background: var(--c-bubble-light);
  border-radius: var(--radius-card);
  padding: 12px 16px;
  color: #333;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  cursor: pointer;
  min-height: 24px;
  backdrop-filter: blur(4px);
  position: relative;
  z-index: 1;
}

.bubble-text {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  max-height: 140px;
  overflow-y: auto;
}

/* 展开态：不限制高度，完整阅读长回复 */
.bubble-body.expanded .bubble-text {
  max-height: none;
  overflow-y: visible;
}

.bubble-toggle {
  position: absolute;
  right: 6px;
  bottom: 4px;
  width: 22px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-control);
  background: rgba(0, 0, 0, 0.06);
  color: inherit;
  font-size: 10px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.bubble-toggle:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.12);
}

.bubble-body.dark .bubble-toggle {
  background: rgba(255, 255, 255, 0.08);
}

.bubble-body.dark .bubble-toggle:hover {
  background: rgba(255, 255, 255, 0.16);
}

/* ---- 思考内容 ---- */
.thinking-block {
  margin-bottom: 8px;
  font-size: 12px;
}

.thinking-summary {
  color: rgba(0, 0, 0, 0.4);
  font-style: italic;
  cursor: pointer;
  user-select: none;
  outline: none;
}

.thinking-summary::-webkit-details-marker {
  color: rgba(0, 0, 0, 0.3);
}

.thinking-text {
  margin-top: 4px;
  color: rgba(0, 0, 0, 0.45);
  font-style: italic;
  line-height: 1.5;
  white-space: pre-wrap;
  max-height: 100px;
  overflow-y: scroll;
}

/* 深色变体：稳定底色，供长文本/深色场景使用 */
.bubble-body.dark {
  background: var(--c-bubble-dark);
  color: var(--c-text);
}

.bubble-body.dark .thinking-summary {
  color: var(--c-text-muted);
}

.bubble-body.dark .thinking-summary::-webkit-details-marker {
  color: var(--c-text-muted);
}

.bubble-body.dark .thinking-text {
  color: var(--c-text-secondary);
}

/* 深色滚动条 */
.thinking-text::-webkit-scrollbar {
  width: 6px;
}

.thinking-text::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-text::-webkit-scrollbar-thumb {
  background: var(--c-border);
  border-radius: 3px;
}

.thinking-text::-webkit-scrollbar-thumb:hover {
  background: var(--c-border-strong);
}

/* ---- 光标 ---- */
.cursor {
  display: inline-block;
  animation: blink 0.8s step-end infinite;
  color: var(--c-text-muted);
  font-weight: bold;
}

@keyframes blink {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0;
  }
}
</style>
