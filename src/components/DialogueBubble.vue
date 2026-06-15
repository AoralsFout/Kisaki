<script setup lang="ts">
/**
 * 对话气泡组件
 *
 * - 非流式模式：缓冲完整文本后，以打字机动画逐字显示
 * - typing=true：打字机动画
 * - typing=false：直接显示完整文本
 * - 打字速度可在设置面板中调整（localStorage: deskpet-typing-speed）
 */
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getTypingSpeed } from '../stores/language'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  text?: string
  thinking?: string
  typing?: boolean
  visible?: boolean
}>(), {
  text: '',
  thinking: '',
  typing: false,
  visible: false,
})

const emit = defineEmits<{
  'typing-end': []
}>()

const displayText = ref('')
const isAnimating = ref(false)
let typingTimer: ReturnType<typeof setInterval> | null = null

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
    <div class="bubble-body" @click="skipTyping">
      <!-- 思考内容（灰色斜体，折叠样式） -->
      <details v-if="thinking" class="thinking-block" @click.stop>
        <summary class="thinking-summary">{{ t('chat.bubble.thinking') }}</summary>
        <div class="thinking-text">{{ thinking }}</div>
      </details>

      <!-- 主文本 -->
      <span class="bubble-text">{{ displayText }}</span>

      <!-- 光标（打字机动画中） -->
      <span v-if="isAnimating" class="cursor">▌</span>
    </div>
  </div>
</template>

<style scoped>
.bubble-wrapper {
  max-width: 500px;
  min-width: 200px;
  margin-bottom: 8px;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.25));
}

.bubble-body {
  background: rgba(255, 255, 255, 0.95);
  border-radius: 12px;
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
  overflow: hidden;
}

/* ---- 思考内容 ---- */
.thinking-block {
  margin-bottom: 8px;
  font-size: 12px;
  /* border-left: 3px solid rgba(0, 0, 0, 0.12); */
  /* padding-left: 8px; */
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
}

/* ---- 光标 ---- */
.cursor {
  display: inline-block;
  animation: blink 0.8s step-end infinite;
  color: #666;
  font-weight: bold;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
