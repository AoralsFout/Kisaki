<script setup lang="ts">
/**
 * 角色渲染切换器
 *
 * 按当前角色的 render 字段挂载静态立绘（IllustrationStage）或 Live2D（Live2DStage）。
 * 两个舞台只负责 renderer 生命周期；状态与控制入口由 CharacterRuntime 统一持有。
 * 本组件只负责按渲染类型切换，并向上转发点击事件。
 */
import { computed } from 'vue'
import { useCharacterStore } from '../character'
import IllustrationStage from './IllustrationStage.vue'
import Live2DStage from './Live2DStage.vue'
import {
  adjustCharacterOpacity,
  isCharacterOpacityWheelEnabled,
} from '../character/opacity'

const props = defineProps<{
  opacity: number
}>()

const emit = defineEmits<{
  click: [event: MouseEvent]
  'update:opacity': [opacity: number]
}>()

const charStore = useCharacterStore()
const isLive2d = computed(() => charStore.render === 'live2d')
function handleWheel(event: WheelEvent) {
  // 穿透命中仍由 img/canvas 的 alpha 掩码决定；这里只改变渲染透明度。
  if (!isCharacterOpacityWheelEnabled()) return
  event.preventDefault()
  event.stopPropagation()
  emit('update:opacity', adjustCharacterOpacity(props.opacity, event.deltaY))
}
</script>

<template>
  <div class="character-renderer" :style="{ opacity: props.opacity }" @wheel="handleWheel">
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
