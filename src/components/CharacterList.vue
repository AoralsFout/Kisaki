<script setup lang="ts">
/**
 * 角色卡片列表
 *
 * 展示所有可用角色，支持选择进入编辑和创建新角色。
 */
defineProps<{
  availableList: string[]
  currentId: string
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
        <!-- <i v-if="id === currentId" class="fas fa-star"></i>
        <i v-else class="fas fa-ribbon"></i> -->
        <i class="fas fa-star"></i>
      </div>
      <div class="card-name">{{ id.charAt(0).toUpperCase() + id.slice(1) }}</div>
      <div class="card-id">{{ id }}</div>
      <!-- <div v-if="id === currentId" class="card-badge">当前</div> -->
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
  background: white;
  border: 1px solid #e5e5e7;
  border-radius: 12px;
  padding: 16px 12px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.char-card:hover {
  border-color: #0071e3;
  box-shadow: 0 2px 8px rgba(0, 113, 227, 0.08);
  transform: translateY(-1px);
}
.char-card-add {
  border: 2px dashed #d2d2d7;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  background: #fafafa;
}
.char-card-add:hover {
  border-color: #0071e3;
  background: #f0f7ff;
}

.card-icon {
  font-size: 28px;
  margin-bottom: 6px;
}

.card-name {
  font-size: 14px;
  font-weight: 600;
  color: #1d1d1f;
}

.card-id {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.card-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 10px;
  background: #0071e3;
  color: white;
  padding: 1px 6px;
  border-radius: 8px;
}
</style>
