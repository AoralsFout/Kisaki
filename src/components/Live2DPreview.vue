<script setup lang="ts">
/**
 * Live2D 编辑器预览
 *
 * 复用 useLive2DScene 渲染正在编辑的角色模型，绑定编辑器的可编辑配置（scale/offset
 * 实时反映未保存改动），固定全身居中、不带桌宠副作用（不注册控制器/掩码）。
 */
import { ref } from 'vue'
import { useLive2DScene } from '../character/live2d/scene'
import { DEFAULT_POSE } from '../character'
import type { Live2DConfig } from '../character'

const props = defineProps<{
  id: string
  config: Live2DConfig | undefined
}>()

const containerRef = ref<HTMLElement>()
const canvasRef = ref<HTMLCanvasElement>()

useLive2DScene(canvasRef, containerRef, {
  id: () => props.id,
  config: () => props.config,
  screenPose: () => DEFAULT_POSE,
})
</script>

<template>
  <div ref="containerRef" class="l2d-preview">
    <canvas ref="canvasRef" class="l2d-preview-canvas" />
    <div v-if="!config?.model" class="l2d-preview-empty">尚未导入模型</div>
  </div>
</template>

<style scoped>
.l2d-preview {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--c-panel);
  overflow: hidden;
}
.l2d-preview-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.l2d-preview-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 13px;
}
</style>
