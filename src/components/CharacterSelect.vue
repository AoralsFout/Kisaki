<script setup lang="ts">
/**
 * 角色切换面板
 */
import { ref, watch } from 'vue'
import { useCharacterStore } from '../stores/character'

const props = defineProps<{
  visible?: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

const charStore = useCharacterStore()
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

function handleSelect(id: string) {
  if (id !== charStore.currentId) {
    emit('select', id)
  }
  emit('close')
}
</script>

<template>
  <Transition name="panel-slide">
    <div v-if="visible" class="overlay" data-pet-solid>
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title"><i class="fas fa-masks-theater"></i> 切换角色</span>
          <div class="header-actions">
            <span class="count">{{ charStore.availableList.length }} 个角色</span>
            <button class="btn-close" @click="emit('close')" aria-label="关闭角色切换面板">✕</button>
          </div>
        </div>

        <div ref="listRef" class="char-list">
          <div
            v-for="id in charStore.availableList"
            :key="id"
            :class="['char-item', { active: id === charStore.currentId }]"
            @click="handleSelect(id)"
          >
            <div class="char-avatar">
              <i v-if="id === charStore.currentId" class="fas fa-star"></i>
              <i v-else class="fas fa-ribbon"></i>
            </div>
            <div class="char-info">
              <div class="char-name">
                {{ id === charStore.currentId ? `${charStore.name}（当前）` : charStore.getCharacterName(id) }}
              </div>
              <div class="char-id">{{ id }}</div>
            </div>
            <div v-if="id === charStore.currentId" class="char-check"><i class="fas fa-check"></i></div>
          </div>

          <div class="list-end"></div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 150;
  backdrop-filter: blur(2px);
}

.panel {
  width: 100%;
  max-width: 420px;
  max-height: 70vh;
  background: rgba(20, 20, 35, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 16px 16px 0 0;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(16px);
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: white;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
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

.char-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.char-list::-webkit-scrollbar {
  width: 4px;
}
.char-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.char-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.char-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.char-item.active {
  background: rgba(102, 126, 234, 0.15);
  border: 1px solid rgba(102, 126, 234, 0.3);
}

.char-avatar {
  font-size: 24px;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.7);
}

.char-info {
  flex: 1;
  min-width: 0;
}

.char-name {
  font-size: 14px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
}

.char-id {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
  margin-top: 2px;
}

.char-check {
  color: #667eea;
  font-weight: bold;
  font-size: 16px;
}

.list-end {
  height: 8px;
}

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
