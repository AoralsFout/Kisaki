<script setup lang="ts">
/**
 * 对话历史面板
 *
 * 展示所有历史消息，可滚动，最新消息在最下方。
 */
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible?: boolean
}>(), {
  visible: false,
})

const emit = defineEmits<{
  close: []
}>()

const chat = useChatStore()
const sessionStore = useSessionStore()
const listRef = ref<HTMLElement | null>(null)

/** 正在二次确认回档的消息 id */
const confirmRollbackId = ref<string | null>(null)

/** 执行回档：还原文件 + 恢复视觉状态 + 截断此后对话 */
async function doRollback(messageId: string) {
  confirmRollbackId.value = null
  await sessionStore.rollbackTo(messageId)
}

// 按 Escape 关闭面板
let keyHandler: ((e: KeyboardEvent) => void) | null = null
watch(() => props.visible, (v) => {
  if (!v) confirmRollbackId.value = null
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
    <div v-if="visible" class="history-overlay" data-pet-solid>
      <div class="history-panel">
        <!-- 头部 -->
        <div class="history-header">
          <span class="history-title"><i class="fas fa-clipboard-list"></i> {{ t('chat.history.title') }}</span>
          <div class="header-actions">
            <span class="msg-count">{{ t('chat.history.count', { n: chat.messages.length }) }}</span>
            <button class="btn-clear" @click="chat.clearMessages()" :title="t('chat.history.clear')"><i
                class="fas fa-trash-can"></i></button>
            <button class="btn-close" @click="emit('close')">✕</button>
          </div>
        </div>

        <!-- 消息列表 -->
        <div ref="listRef" class="message-list">
          <div v-if="chat.messages.length === 0" class="empty-hint">
            {{ t('chat.history.empty') }}
          </div>

          <div v-for="msg in chat.messages" :key="msg.id" :class="['message', msg.role]">
            <div class="msg-avatar">
              <i v-if="msg.role === 'user'" class="fas fa-user"></i>
              <i v-else class="fas fa-star"></i>
            </div>
            <div class="msg-content">
              <div class="msg-role-label">
                {{ msg.role === 'user' ? t('chat.history.you') : 'Kisaki' }}
                <span class="msg-time">{{ new Date(msg.timestamp).toLocaleTimeString() }}</span>
              </div>
              <!-- 思考内容（仅 assistant 消息可能有） -->
              <details v-if="msg.thinking" class="thinking-block">
                <summary class="thinking-summary">{{ t('chat.history.thinking') }}</summary>
                <div class="thinking-text">{{ msg.thinking }}</div>
              </details>
              <div class="msg-text">{{ msg.text }}</div>

              <!-- 回档（仅用户消息）：还原文件 + 截断此后对话 -->
              <div v-if="msg.role === 'user'" class="msg-rollback">
                <template v-if="confirmRollbackId === msg.id">
                  <span class="rb-q">{{ t('chat.history.rollbackConfirm') }}</span>
                  <button class="rb-yes" @click="doRollback(msg.id)">{{ t('chat.history.rollbackYes') }}</button>
                  <button class="rb-no" @click="confirmRollbackId = null">{{ t('common.cancel') }}</button>
                </template>
                <button
                  v-else
                  class="rb-btn"
                  :disabled="chat.isProcessing"
                  :title="t('chat.history.rollbackTitle')"
                  @click="confirmRollbackId = msg.id"
                >
                  <i class="fas fa-clock-rotate-left"></i> {{ t('chat.history.rollback') }}
                </button>
              </div>
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

/* ---- 回档控件（用户消息） ---- */
.msg-rollback {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  justify-content: flex-end;
  min-height: 18px;
}

.rb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  padding: 2px 4px;
  border-radius: 6px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.message.user:hover .rb-btn {
  opacity: 1;
}

.rb-btn:hover:not(:disabled) {
  color: #f0b85c;
  background: rgba(240, 184, 92, 0.12);
}

.rb-btn:disabled {
  cursor: not-allowed;
}

.rb-q {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
}

.rb-yes,
.rb-no {
  font-size: 10px;
  border: none;
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
}

.rb-yes {
  background: rgba(240, 184, 92, 0.85);
  color: #2a2030;
  font-weight: 600;
}

.rb-yes:hover {
  background: #f0b85c;
}

.rb-no {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
}

.rb-no:hover {
  background: rgba(255, 255, 255, 0.15);
}

/* ---- 思考内容 ---- */
.thinking-block {
  margin: 4px 0 6px;
  font-size: 12px;
  /* border-left: 2px solid rgba(255, 255, 255, 0.1);
  padding-left: 8px; */
}

.thinking-summary {
  color: rgba(255, 255, 255, 0.35);
  font-style: italic;
  cursor: pointer;
  user-select: none;
  outline: none;
  font-size: 10px;
}

.thinking-text {
  margin-top: 3px;
  color: rgba(255, 255, 255, 0.3);
  font-style: italic;
  line-height: 1.5;
  white-space: pre-wrap;
  font-size: 10px;
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
