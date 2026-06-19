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
import { computed } from 'vue'
import { useCharacterStore } from '../character'
import IllustrationStage from './IllustrationStage.vue'
import Live2DStage from './Live2DStage.vue'

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const charStore = useCharacterStore()
const isLive2d = computed(() => charStore.render === 'live2d')
</script>

<template>
  <Live2DStage v-if="isLive2d" @click="emit('click', $event)" />
  <IllustrationStage v-else @click="emit('click', $event)" />
</template>
