<script setup lang="ts">
/**
 * 角色切换面板
 */
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCharacterStore } from '../stores/character'
import { useModalFocus } from '../utils/modalFocus'

const { t } = useI18n()

const props = defineProps<{
  visible?: boolean
}>()

const emit = defineEmits<{
  close: []
  select: [id: string]
}>()

const charStore = useCharacterStore()
const listRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const titleId = useId()
useModalFocus(() => Boolean(props.visible), panelRef, () => emit('close'))

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
      <section ref="panelRef" class="panel" role="dialog" aria-modal="true"
        :aria-labelledby="titleId" tabindex="-1">
        <div class="panel-header">
          <h2 :id="titleId" class="panel-title"><i class="fas fa-masks-theater"></i> {{ t('character.select.title') }}</h2>
          <div class="header-actions">
            <span class="count">{{ t('character.select.count', { n: charStore.availableList.length }) }}</span>
            <button class="btn-close" @click="emit('close')" :aria-label="t('character.select.aria')">✕</button>
          </div>
        </div>

        <div ref="listRef" class="char-list">
          <button
            v-for="id in charStore.availableList"
            :key="id"
            :class="['char-item', { active: id === charStore.currentId }]"
            :aria-current="id === charStore.currentId ? 'true' : undefined"
            @click="handleSelect(id)"
          >
            <div class="char-avatar">
              <i v-if="id === charStore.currentId" class="fas fa-star"></i>
              <i v-else class="fas fa-ribbon"></i>
            </div>
            <div class="char-info">
              <div class="char-name">
                {{ id === charStore.currentId ? t('character.select.current', { name: charStore.name }) : charStore.getCharacterName(id) }}
              </div>
              <div class="char-id">{{ id }}</div>
            </div>
            <div v-if="id === charStore.currentId" class="char-check"><i class="fas fa-check"></i></div>
          </button>

          <div class="list-end"></div>
        </div>
      </section>
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
  margin: 0;
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
  font-size: var(--fs-aux);
  color: rgba(255, 255, 255, 0.65);
}

.btn-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.72);
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
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
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
  font-size: var(--fs-aux);
  color: rgba(255, 255, 255, 0.58);
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

@media (max-height: 520px) {
  .panel { max-height: 88vh; }
}
</style>
