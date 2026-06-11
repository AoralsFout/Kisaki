<script setup lang="ts">
/**
 * 对话气泡组件
 *
 * - 流式模式（typing=true）：直接显示 props.text，不逐字动画
 * - 固定模式（typing=false）：显示完整文本
 * - 支持 thinking 内容（如 DeepSeek 推理过程）以灰色斜体展示
 */
import { ref, watch } from 'vue'

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

// 流式模式下直接用 props.text，不做动画
const displayText = ref('')

watch(
  () => props.text,
  (newText) => {
    displayText.value = newText ?? ''
    if (!newText) return
    // typing=false 或第一次赋值时立即触发 typing-end
    if (!props.typing) {
      emit('typing-end')
    }
  },
  { immediate: true },
)

/** 跳过打字/直接显示完整文本 */
function skipTyping() {
  displayText.value = props.text
  emit('typing-end')
}

defineExpose({ skipTyping })
</script>

<template>
  <div v-show="visible" class="bubble-wrapper">
    <div class="bubble-body" @click="skipTyping">
      <!-- 思考内容（灰色斜体，折叠样式） -->
      <details v-if="thinking" class="thinking-block" @click.stop>
        <summary class="thinking-summary">Thinking</summary>
        <div class="thinking-text">{{ thinking }}</div>
      </details>

      <!-- 主文本 -->
      <span class="bubble-text">{{ displayText }}</span>

      <!-- 光标（流式输出中） -->
      <span v-if="typing && text" class="cursor">▌</span>
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
}

/* ---- 思考内容 ---- */
.thinking-block {
  margin-bottom: 8px;
  font-size: 12px;
  border-left: 3px solid rgba(0, 0, 0, 0.12);
  padding-left: 8px;
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
