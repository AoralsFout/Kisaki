<script setup lang="ts">
/**
 * 角色渲染切换器
 *
 * 按当前角色的 render 字段挂载静态立绘（IllustrationStage）或 Live2D（Live2DStage）。
 * 立绘的控制器/注册逻辑在 IllustrationStage 内；Live2D 的控制器在 Live2DStage 内。
 * 本组件只负责按渲染类型切换，并向上转发点击事件。
 *
 * App.vue 通过 commandBus 的 getCharacterController()（立绘）/ agent 上下文（Live2D）
 * 访问控制器，不再依赖本组件的实例暴露。
 */
import { computed, ref } from 'vue'
import { useCharacterStore } from '../character'
import IllustrationStage from './IllustrationStage.vue'
import Live2DStage from './Live2DStage.vue'
import {
  adjustCharacterOpacity,
  getCharacterOpacity,
  isCharacterOpacityWheelEnabled,
} from '../character/opacity'

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const charStore = useCharacterStore()
const isLive2d = computed(() => charStore.render === 'live2d')
const opacity = ref(getCharacterOpacity())

function handleWheel(event: WheelEvent) {
  // 穿透命中仍由 img/canvas 的 alpha 掩码决定；这里只改变渲染透明度。
  if (!isCharacterOpacityWheelEnabled()) return
  event.preventDefault()
  event.stopPropagation()
  opacity.value = adjustCharacterOpacity(opacity.value, event.deltaY)
}
</script>

<template>
  <div class="character-renderer" :style="{ opacity }" @wheel="handleWheel">
    <Live2DStage v-if="isLive2d" @click="emit('click', $event)" />
    <IllustrationStage v-else @click="emit('click', $event)" />
  </div>
</template>

<style scoped>
.character-renderer {
  width: 100%;
  height: 100%;
  transition: opacity 80ms linear;
}
</style>
