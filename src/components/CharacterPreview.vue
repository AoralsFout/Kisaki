<script setup lang="ts">
/**
 * 立绘预览与编辑面板（右侧）
 *
 * 展示选中立绘的大图，支持编辑姿势/服装/情绪标签。
 */
import { ref } from 'vue'
import type { CharacterImageData } from '../character/loader'

const props = defineProps<{
  image: CharacterImageData | null
  imageUrl: string
  poses: string[]
  costumes: string[]
}>()

const emit = defineEmits<{
  'update-pose': [file: string, pose: string]
  'update-costume': [file: string, costume: string]
  'add-emotion': [file: string, emotion: string]
  'remove-emotion': [file: string, index: number]
  delete: [file: string]
  close: []
}>()

const emotionInput = ref('')

function handleEmotionKeydown(e: KeyboardEvent) {
  if (e.key === ' ') {
    e.preventDefault()
    const val = emotionInput.value.trim()
    if (!val || !props.image) return
    emit('add-emotion', props.image.file, val)
    emotionInput.value = ''
  }
}
</script>

<template>
  <div class="preview-panel" :class="{ open: image !== null }">
    <template v-if="image">
      <div class="preview-header">
        <span class="preview-filename">{{ image.file }}</span>
        <div class="preview-actions">
          <button class="preview-btn preview-btn-del" @click="emit('delete', image.file)" title="删除此立绘"><i class="fas fa-trash-can"></i></button>
          <button class="preview-btn" @click="emit('close')" title="关闭">✕</button>
        </div>
      </div>

      <div class="preview-image">
        <img :src="imageUrl" :alt="image.file" />
      </div>

      <div class="preview-editor">
        <div class="edit-row">
          <label>姿势</label>
          <select
            :value="image.pose"
            @change="emit('update-pose', image.file, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="p in poses" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>

        <div class="edit-row">
          <label>服装</label>
          <select
            :value="image.costume"
            @change="emit('update-costume', image.file, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="c in costumes" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>

        <div class="edit-row">
          <label>情绪</label>
          <div class="emotion-edit">
            <code
              v-for="(em, ei) in image.emotions"
              :key="ei"
              class="em-tag"
              @click="emit('remove-emotion', image.file, ei)"
              title="点击移除"
            >{{ em }} ✕</code>
            <input
              v-model="emotionInput"
              class="emotion-input"
              @keydown="handleEmotionKeydown"
              placeholder="输入后按空格添加"
            />
          </div>
        </div>
      </div>
    </template>
    <div v-else class="preview-empty">
      ← 从左侧选择一张立绘
    </div>
  </div>
</template>

<style scoped>
.preview-panel {
  width: 0;
  overflow: hidden;
  background: #16162a;
  border-left: 1px solid #2a2a4a;
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
}

.preview-panel.open {
  width: 340px;
  flex-shrink: 0;
  overflow: hidden;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a4a;
  flex-shrink: 0;
}

.preview-filename {
  font-size: 12px;
  font-family: monospace;
  color: #aaa;
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.preview-btn {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  color: #666;
  padding: 2px 6px;
  border-radius: 4px;
}

.preview-btn:hover {
  background: #2a2a4a;
  color: #ddd;
}
.preview-btn-del:hover {
  background: rgba(239, 83, 80, 0.15);
  color: #ef5350;
}

.preview-image {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: #1a1a2e;
  overflow: hidden;
}

.preview-image img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-editor {
  padding: 10px 12px;
  border-top: 1px solid #2a2a4a;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.preview-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 13px;
}

.edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-row label {
  font-size: 11px;
  color: #888;
  width: 40px;
  flex-shrink: 0;
}

.edit-row select {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
}

.emotion-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
  flex: 1;
}

.em-tag {
  font-size: 11px;
  background: rgba(74, 122, 255, 0.15);
  color: #7c8cff;
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
  font-family: monospace;
}

.em-tag:hover {
  background: rgba(239, 83, 80, 0.15);
  color: #ef5350;
}

.emotion-input {
  flex: 1;
  min-width: 120px;
  padding: 3px 8px;
  font-size: 12px;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  font-family: inherit;
}

.emotion-input:focus {
  border-color: #4a7aff;
}
</style>
