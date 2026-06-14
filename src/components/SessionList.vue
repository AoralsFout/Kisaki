<script setup lang="ts">
/**
 * 会话管理面板
 *
 * 底部弹出式面板，展示所有会话（按更新时间倒序）：
 * - 点击切换会话
 * - 新建会话
 * - 删除会话（至少保留一个）
 * - 重命名会话（双击或点击编辑按钮）
 */
import { ref, watch, nextTick } from 'vue'
import { useSessionStore } from '../stores/session'

const props = withDefaults(defineProps<{
  visible?: boolean
}>(), {
  visible: false,
})

const emit = defineEmits<{
  close: []
}>()

const sessionStore = useSessionStore()

/** 正在编辑重命名的会话 ID */
const editingId = ref<string | null>(null)
const editName = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

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

// 关闭面板时取消编辑状态
watch(() => props.visible, (v) => {
  if (!v) editingId.value = null
})

function handleSelect(id: string) {
  if (id !== sessionStore.currentSessionId) {
    sessionStore.switchSession(id)
  }
  emit('close')
}

function handleCreate() {
  sessionStore.createSession()
  emit('close')
}

function handleDelete(id: string) {
  sessionStore.deleteSession(id)
}

function startRename(id: string) {
  const session = sessionStore.getSessionById(id)
  if (!session) return
  editingId.value = id
  editName.value = session.name
  nextTick(() => {
    editInputRef.value?.focus()
    editInputRef.value?.select()
  })
}

function confirmRename(id: string) {
  if (editingId.value !== id) return
  sessionStore.renameSession(id, editName.value)
  editingId.value = null
}

function cancelRename() {
  editingId.value = null
  editName.value = ''
}

function handleEditKeydown(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmRename(id)
  } else if (e.key === 'Escape') {
    cancelRename()
  }
}
</script>

<template>
  <Transition name="panel-slide">
    <div v-if="visible" class="session-overlay" data-pet-solid>
      <div class="session-panel">
        <!-- 头部 -->
        <div class="session-header">
          <span class="session-title">
            <i class="fas fa-comments"></i> 会话管理
          </span>
          <div class="header-actions">
            <button class="btn-new" @click="handleCreate" title="新建会话">
              <i class="fas fa-plus"></i> 新建
            </button>
            <span class="session-count">{{ sessionStore.sessionList.length }} 个会话</span>
            <button class="btn-close" @click="emit('close')" aria-label="关闭">&times;</button>
          </div>
        </div>

        <!-- 会话列表 -->
        <div class="session-list">
          <div v-if="sessionStore.sessionList.length === 0" class="empty-hint">
            暂无会话
          </div>

          <div
            v-for="s in sessionStore.sessionList"
            :key="s.id"
            :class="['session-item', { active: s.id === sessionStore.currentSessionId }]"
            @click="editingId !== s.id && handleSelect(s.id)"
          >
            <!-- 图标 -->
            <div class="session-icon">
              <i v-if="s.id === sessionStore.currentSessionId" class="fas fa-message"></i>
              <i v-else class="far fa-message"></i>
            </div>

            <!-- 会话信息 -->
            <div class="session-info">
              <!-- 编辑模式 -->
              <input
                v-if="editingId === s.id"
                ref="editInputRef"
                v-model="editName"
                class="session-rename-input"
                @keydown="handleEditKeydown($event, s.id)"
                @blur="confirmRename(s.id)"
                @click.stop
              />
              <!-- 显示模式 -->
              <template v-else>
                <div class="session-name">{{ s.name }}</div>
                <div class="session-meta">
                  <span class="session-msg-count">{{ s.messages.length }} 条消息</span>
                  <span class="session-time">{{ new Date(s.updatedAt).toLocaleString() }}</span>
                </div>
              </template>
            </div>

            <!-- 操作按钮 -->
            <div class="session-actions" @click.stop>
              <!-- 仅非编辑模式显示操作按钮 -->
              <template v-if="editingId !== s.id">
                <button
                  class="btn-icon-only"
                  title="重命名"
                  @click="startRename(s.id)"
                >
                  <i class="fas fa-pen"></i>
                </button>
                <button
                  v-if="sessionStore.sessionList.length > 1"
                  class="btn-icon-only btn-danger"
                  title="删除"
                  @click="handleDelete(s.id)"
                >
                  <i class="fas fa-trash-can"></i>
                </button>
              </template>
            </div>
          </div>

          <div class="list-end"></div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.session-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 150;
  backdrop-filter: blur(2px);
}

.session-panel {
  width: 100%;
  max-width: 520px;
  max-height: 75vh;
  background: rgba(20, 20, 35, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 16px 16px 0 0;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(16px);
  overflow: hidden;
}

/* ---- 头部 ---- */
.session-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.session-title {
  font-size: 14px;
  font-weight: 600;
  color: white;
  display: flex;
  align-items: center;
  gap: 6px;
}

.session-title i {
  color: #667eea;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}

.btn-new {
  background: linear-gradient(135deg, #667eea, #764ba2);
  border: none;
  color: white;
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.2s;
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-new:hover {
  opacity: 0.85;
}

.btn-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 18px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}

.btn-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}

/* ---- 会话列表 ---- */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-list::-webkit-scrollbar {
  width: 4px;
}

.session-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.empty-hint {
  text-align: center;
  color: rgba(255, 255, 255, 0.25);
  font-size: 13px;
  padding: 40px 0;
}

/* ---- 会话项 ---- */
.session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
}

.session-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.session-item.active {
  background: rgba(102, 126, 234, 0.15);
  border: 1px solid rgba(102, 126, 234, 0.3);
}

.session-icon {
  flex-shrink: 0;
  font-size: 18px;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.5);
}

.session-item.active .session-icon {
  color: #667eea;
  background: rgba(102, 126, 234, 0.15);
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 14px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 2px;
}

.session-msg-count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}

.session-time {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.25);
}

/* ---- 重命名输入框 ---- */
.session-rename-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(102, 126, 234, 0.5);
  border-radius: 6px;
  padding: 4px 8px;
  color: white;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.session-rename-input:focus {
  border-color: #667eea;
}

/* ---- 操作按钮 ---- */
.session-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.btn-icon-only {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  transition: background 0.15s, color 0.15s;
}

.btn-icon-only:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
}

.btn-icon-only.btn-danger:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.list-end {
  height: 8px;
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
