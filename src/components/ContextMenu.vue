<script setup lang="ts">
/**
 * 右键菜单组件
 */
import { ref, onMounted, onUnmounted } from 'vue'

export interface MenuItem {
  label: string
  icon?: string
  action: () => void
  disabled?: boolean
  divider?: boolean
}

withDefaults(defineProps<{
  items: MenuItem[]
  visible?: boolean
}>(), { visible: false })

const emit = defineEmits<{
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)
const position = ref({ x: 0, y: 0 })

function show(x: number, y: number) {
  position.value = { x, y }
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

function handleItemClick(item: MenuItem) {
  if (item.disabled) return
  emit('close')
  item.action()
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

defineExpose({ show })
</script>

<template>
  <Transition name="menu-fade">
    <div
      v-if="visible"
      ref="menuRef"
      class="context-menu"
      :style="{
        left: position.x + 'px',
        top: position.y + 'px',
      }"
    >
      <template v-for="(item, idx) in items" :key="idx">
        <div v-if="item.divider" class="menu-divider"></div>
        <div
          v-else
          class="menu-item"
          :class="{ disabled: item.disabled }"
          @click="handleItemClick(item)"
        >
          <span v-if="item.icon" class="menu-icon">{{ item.icon }}</span>
          <span class="menu-label">{{ item.label }}</span>
        </div>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  background: rgba(30, 30, 40, 0.95);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}

.menu-item:hover:not(.disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.menu-item.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.menu-icon {
  font-size: 15px;
  width: 20px;
  text-align: center;
}

.menu-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 4px 8px;
}

/* 过渡动画 */
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: all 0.15s ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
