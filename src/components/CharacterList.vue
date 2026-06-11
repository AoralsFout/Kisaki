<script setup lang="ts">
/**
 * 角色卡片列表
 *
 * 展示所有可用角色，支持选择进入编辑和创建新角色。
 */
defineProps<{
  availableList: string[]
  currentId: string
  /** 根据角色 ID 获取显示名称的函数 */
  getCharacterName?: (id: string) => string
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
}>()
</script>

<template>
  <div class="char-grid">
    <div
      v-for="id in availableList"
      :key="id"
      class="char-card"
      @click="emit('select', id)"
    >
      <div class="card-icon">
        <i class="fas fa-star"></i>
      </div>
      <div class="card-name">{{ getCharacterName?.(id) ?? id.charAt(0).toUpperCase() + id.slice(1) }}</div>
      <div class="card-id">{{ id }}</div>
    </div>
    <div class="char-card char-card-add" @click="emit('create')">
      <div class="card-icon" style="font-size:32px;color:#aaa;">+</div>
      <div class="card-name" style="color:#999;">添加角色</div>
    </div>
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
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 16px 12px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.char-card:hover {
  border-color: #4a7aff;
  box-shadow: 0 2px 8px rgba(74, 122, 255, 0.12);
  transform: translateY(-1px);
}
.char-card-add {
  border: 2px dashed #2a2a4a;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  background: transparent;
}
.char-card-add:hover {
  border-color: #4a7aff;
  background: rgba(74, 122, 255, 0.08);
}

.card-icon {
  font-size: 28px;
  margin-bottom: 6px;
  color: #aaa;
}

.card-name {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.card-id {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}
</style>
