<script setup lang="ts">
/**
 * 聊天面板 —— 会话标题 + 消息列表 + 输入框的连续面板
 *
 * 取代「历史浮层 + 底部悬浮输入框」的往返切换：打开即读、即输入。
 * - 头部：当前会话标题（可跳转会话管理）、上下文预算、清空；
 * - 中部：完整历史消息（生成中仍可阅读，回档/清空等改变上下文的操作被锁定）；
 * - 底部：内嵌 InputBox，草稿按会话隔离。
 */
import { ref, watch, nextTick } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'
import InputBox from './InputBox.vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { useCharacterStore } from '../character'
import type { ChatInputPayload } from '../ai'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible?: boolean
  /** 发送回调（App 提供，等待父组件接受结果） */
  submit?: (payload: ChatInputPayload) => Promise<boolean>
}>(), {
  visible: false,
})

const emit = defineEmits<{
  close: []
  'switch-session': []
}>()

const chat = useChatStore()
const sessionStore = useSessionStore()
const charStore = useCharacterStore()
const listRef = ref<HTMLElement | null>(null)
const clearTarget = ref<{ id: string; name: string } | null>(null)
function requestClear() {
  if (chat.isProcessing) return // 生成中锁定改变上下文的操作
  const session = sessionStore.currentSession
  if (session) clearTarget.value = { id: session.id, name: session.name }
}
function confirmClear() {
  if (clearTarget.value?.id === sessionStore.currentSessionId) chat.clearMessages()
  clearTarget.value = null
}

/** 助手消息展示名：优先消息内的角色身份快照，旧数据回退当前角色名/品牌名 */
function assistantLabel(charName?: string): string {
  return charName || charStore.name || 'Kisaki'
}

/** 正在二次确认回档的消息 id */
const confirmRollbackId = ref<string | null>(null)

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
}

/** 执行回档：还原文件 + 恢复视觉状态 + 截断此后对话 */
async function doRollback(messageId: string) {
  confirmRollbackId.value = null
  await sessionStore.rollbackTo(messageId)
}

// 按 Escape 关闭面板
let keyHandler: ((e: KeyboardEvent) => void) | null = null
watch(() => props.visible, (v) => {
  if (!v) { confirmRollbackId.value = null; clearTarget.value = null }
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

// 滚到底部：新消息平滑滚动；面板打开时瞬时定位（不做进入动画）
function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  nextTick(() => {
    listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior })
  })
}
watch(
  () => chat.messages.length,
  () => { if (props.visible) scrollToBottom() },
)
watch(
  () => props.visible,
  (v) => { if (v) scrollToBottom('auto') },
)
</script>

<template>
  <ConfirmDialog :visible="Boolean(clearTarget)" :title="t('safety.clearTitle')"
    :message="t('safety.clearBody', { name: clearTarget?.name })" :confirm-label="t('safety.clearAction')" danger
    @cancel="clearTarget = null" @confirm="confirmClear" />
  <div v-if="visible" class="history-overlay" data-pet-solid>
      <div class="history-panel">
        <!-- 头部：会话标题 + 操作 -->
        <div class="history-header">
          <button class="session-title" :title="t('chat.history.switchSession')" @click="emit('switch-session')">
            <i class="fas fa-comments"></i>
            <span class="session-name">{{ sessionStore.currentSession?.name ?? t('chat.history.title') }}</span>
            <i class="fas fa-chevron-up session-switch-hint"></i>
          </button>
          <div class="header-actions">
            <span class="msg-count">{{ t('chat.history.count', { n: chat.messages.length }) }}</span>
            <button class="btn-clear" :disabled="chat.isProcessing" @click="requestClear"
              :title="t('chat.history.clear')"><i class="fas fa-trash-can"></i></button>
            <button class="btn-close" @click="emit('close')">✕</button>
          </div>
        </div>

        <div class="context-status" :title="t('chat.history.contextDetail', {
          used: chat.contextStats.estimatedTokens,
          max: chat.contextStats.maxContextTokens,
          tools: chat.contextStats.toolDefinitionTokens,
          pruned: chat.contextStats.prunedMessages,
        })">
          <span>{{ t('chat.history.context') }}</span>
          <div class="context-meter"><i :style="{ width: `${Math.round(chat.contextStats.utilization * 100)}%` }"></i></div>
          <span>{{ formatTokens(chat.contextStats.estimatedTokens) }}/{{ formatTokens(chat.contextStats.maxContextTokens) }}</span>
          <span v-if="chat.contextStats.summarizedRounds > 0">{{ t('chat.history.summarized', { n: chat.contextStats.summarizedRounds }) }}</span>
        </div>

        <!-- 消息列表（生成中仍可阅读） -->
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
                {{ msg.role === 'user' ? t('chat.history.you') : assistantLabel(msg.charName) }}
                <span class="msg-time">{{ new Date(msg.timestamp).toLocaleTimeString() }}</span>
              </div>
              <!-- 思考内容（仅 assistant 消息可能有） -->
              <details v-if="msg.thinking" class="thinking-block">
                <summary class="thinking-summary">{{ t('chat.history.thinking') }}</summary>
                <div class="thinking-text">{{ msg.thinking }}</div>
              </details>
              <div v-if="msg.images?.length" class="msg-images">
                <img v-for="image in msg.images" :key="image.id" :src="image.dataUrl" :alt="image.name" />
              </div>
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

        <!-- 输入区：与消息列表同面板，免去历史/输入往返切换 -->
        <div class="panel-input">
          <InputBox :visible="visible" :disabled="chat.isProcessing" :draft-key="sessionStore.currentSessionId"
            :valid-draft-keys="sessionStore.sessionList.map(s => s.id)" :submit="submit" />
        </div>
      </div>
    </div>
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
  max-width: min(520px, 94vw);
  max-height: 86vh;
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

/* 会话标题：点击跳转会话管理 */
.session-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 8px;
  margin-left: -8px;
  background: none;
  border: none;
  border-radius: var(--radius-control);
  color: var(--c-text-bright);
  cursor: pointer;
  transition: background 0.15s;
}

.session-title:hover {
  background: rgba(255, 255, 255, 0.08);
}

.session-name {
  font-size: var(--fs-body);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.session-switch-hint {
  font-size: 10px;
  color: var(--c-text-muted);
}

.context-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 16px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.context-meter {
  width: 64px;
  height: 4px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
}

.context-meter i {
  display: block;
  height: 100%;
  max-width: 100%;
  background: linear-gradient(90deg, #667eea, #f0b85c);
  transition: width 0.2s ease;
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

.btn-clear:hover:not(:disabled) {
  opacity: 1;
}

.btn-clear:disabled {
  cursor: not-allowed;
  opacity: 0.25;
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

.msg-images {
  /* 多图自适应换行，窄窗口不裁切 */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 6px;
  margin-bottom: 7px;
  max-width: 280px;
}

.msg-images img {
  width: 100%;
  max-height: 120px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
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

/* ---- 底部输入区：与消息列表同面板 ---- */
.panel-input {
  flex-shrink: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(16, 16, 30, 0.92);
}
</style>
