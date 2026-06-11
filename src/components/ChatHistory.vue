<script setup lang="ts">
/**
 * 对话历史面板
 *
 * 展示所有历史消息，可滚动，最新消息在最下方。
 */
import { ref, watch, nextTick } from 'vue'
import { useChatStore } from '../stores/chat'

const props = withDefaults(defineProps<{
  visible?: boolean
}>(), {
  visible: false,
})

const emit = defineEmits<{
  close: []
}>()

const chat = useChatStore()
const listRef = ref<HTMLElement | null>(null)

// 按 Escape 关闭面板
let keyHandler: ((e: KeyboardEvent) => void) | null = null
watch(() => props.visible, (v) => {
  if (v) {
    keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') emit('close')
    }
    document.addEventListener('keydown', keyHandler)
  } else if (keyHandler) {
    document.removeEventListener('keydown', keyHandler)
    keyHandler = null
  }
})

// 消息数量变化时自动滚到底部
watch(
  () => chat.messages.length,
  () => {
    if (props.visible) {
      nextTick(() => {
        listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior: 'smooth' })
      })
    }
  },
)
</script>

<template>
  <Transition name="panel-slide">
    <div v-if="visible" class="history-overlay">
      <div class="history-panel">
        <!-- 头部 -->
        <div class="history-header">
          <span class="history-title"><i class="fas fa-clipboard-list"></i> 对话历史</span>
          <div class="header-actions">
            <span class="msg-count">{{ chat.messages.length }} 条</span>
            <button class="btn-clear" @click="chat.clearMessages()" title="清空历史"><i
                class="fas fa-trash-can"></i></button>
            <button class="btn-close" @click="emit('close')">✕</button>
          </div>
        </div>

        <!-- 消息列表 -->
        <div ref="listRef" class="message-list">
          <div v-if="chat.messages.length === 0" class="empty-hint">
            暂无对话记录
          </div>

          <div v-for="msg in chat.messages" :key="msg.id" :class="['message', msg.role]">
            <div class="msg-avatar">
              <i v-if="msg.role === 'user'" class="fas fa-user"></i>
              <i v-else class="fas fa-star"></i>
            </div>
            <div class="msg-content">
              <div class="msg-role-label">
                {{ msg.role === 'user' ? '你' : 'Kisaki' }}
                <span class="msg-time">{{ new Date(msg.timestamp).toLocaleTimeString() }}</span>
              </div>
              <!-- 思考内容（仅 assistant 消息可能有） -->
              <details v-if="msg.thinking" class="thinking-block">
                <summary class="thinking-summary">思考过程</summary>
                <div class="thinking-text">{{ msg.thinking }}</div>
              </details>
              <div class="msg-text">{{ msg.text }}</div>
            </div>
          </div>

          <!-- 底部占位，确保最后一条不被遮挡 -->
          <div class="list-end"></div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.history-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 150;
  backdrop-filter: blur(2px);
}

.history-panel {
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  background: rgba(20, 20, 35, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 16px 16px 0 0;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(16px);
  overflow: hidden;
}

/* ---- 头部 ---- */
.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.history-title {
  font-size: 14px;
  font-weight: 600;
  color: white;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.msg-count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}

.btn-clear {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  opacity: 0.5;
  color: rgba(255, 255, 255, 0.4);
}

.btn-clear:hover {
  opacity: 1;
}

.btn-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.btn-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}

/* ---- 消息列表 ---- */
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message-list::-webkit-scrollbar {
  width: 4px;
}

.message-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.empty-hint {
  text-align: center;
  color: rgba(255, 255, 255, 0.25);
  font-size: 13px;
  padding: 40px 0;
}

/* ---- 单条消息 ---- */
.message {
  display: flex;
  gap: 10px;
  max-width: 90%;
}

.message.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message.assistant {
  align-self: flex-start;
}

.msg-avatar {
  flex-shrink: 0;
  font-size: 20px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 50%;

  >i {
    color: rgba(255, 255, 255, 0.4);
  }
}

.msg-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.msg-role-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  display: flex;
  gap: 6px;
  align-items: center;
}

.msg-time {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.2);
}

.msg-text {
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.85);
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(255, 255, 255, 0.04);
  padding: 8px 12px;
  border-radius: 10px;
}

.message.user .msg-text {
  background: rgba(102, 126, 234, 0.2);
}

.message.assistant .msg-text {
  background: rgba(118, 75, 162, 0.15);
}

/* ---- 思考内容 ---- */
.thinking-block {
  margin: 4px 0 6px;
  font-size: 12px;
  border-left: 2px solid rgba(255, 255, 255, 0.1);
  padding-left: 8px;
}

.thinking-summary {
  color: rgba(255, 255, 255, 0.35);
  font-style: italic;
  cursor: pointer;
  user-select: none;
  outline: none;
  font-size: 11px;
}

.thinking-text {
  margin-top: 3px;
  color: rgba(255, 255, 255, 0.3);
  font-style: italic;
  line-height: 1.5;
  white-space: pre-wrap;
  font-size: 12px;
}

.list-end {
  height: 4px;
  flex-shrink: 0;
}

/* ---- 过渡动画 ---- */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: all 0.25s ease;
}

.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateY(30px);
  opacity: 0;
}
</style>
