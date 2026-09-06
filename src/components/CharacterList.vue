<script setup lang="ts">
/**
 * 角色卡片列表
 *
 * 展示所有可用角色，支持选择进入编辑和创建新角色。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  availableList: string[]
  currentId: string
  /** 根据角色 ID 获取显示名称的函数 */
  getCharacterName?: (id: string) => string
  /** 获取角色渲染类型（live2d 显示徽标） */
  getCharacterRender?: (id: string) => string
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
}>()
</script>

<template>
  <div class="char-grid">
    <button
      v-for="id in availableList"
      :key="id"
      type="button"
      class="char-card"
      :aria-current="id === currentId ? 'true' : undefined"
      @click="emit('select', id)"
    >
      <div v-if="getCharacterRender?.(id) === 'live2d'" class="card-badge">{{ t('character.mgr.live2d.badge') }}</div>
      <div class="card-icon">
        <i class="fas fa-star"></i>
      </div>
      <div class="card-name">{{ getCharacterName?.(id) ?? id.charAt(0).toUpperCase() + id.slice(1) }}</div>
      <div class="card-id">{{ id }}</div>
    </button>
    <button type="button" class="char-card char-card-add" @click="emit('create')">
      <div class="card-icon" style="font-size:32px;color:var(--c-text-secondary);">+</div>
      <div class="card-name" style="color:var(--c-text-muted);">{{ t('character.list.add') }}</div>
    </button>
  </div>
</template>

<style scoped>
.char-grid {
  display: grid;
  padding: 16px;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
}

.char-card {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 16px 12px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
  font: inherit;
  width: 100%;
}

.char-card:hover {
  border-color: var(--c-brand);
  box-shadow: 0 2px 8px rgba(74, 122, 255, 0.12);
  transform: translateY(-1px);
}
.char-card-add {
  border: 2px dashed var(--c-border);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  background: transparent;
}
.char-card-add:hover {
  border-color: var(--c-brand);
  background: rgba(74, 122, 255, 0.08);
}

.card-icon {
  font-size: 28px;
  margin-bottom: 6px;
  color: var(--c-text-secondary);
}

.card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
}

.card-id {
  font-size: var(--fs-aux);
  color: var(--c-text-muted);
  margin-top: 2px;
}

.card-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: var(--fs-aux);
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #7c8cff;
  background: rgba(74, 122, 255, 0.15);
  border: 1px solid rgba(74, 122, 255, 0.4);
  border-radius: 4px;
  padding: 1px 5px;
}
</style>
