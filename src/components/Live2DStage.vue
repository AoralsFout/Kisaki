<script setup lang="ts">
/**
 * Live2D 桌宠舞台
 *
 * 用共享的 useLive2DScene 渲染当前角色模型，叠加桌宠专属副作用：模型 ready 后
 * 注册 Live2D 控制器（供 AI 工具）+ 启动穿透掩码快照；卸载时解绑。
 * 屏幕姿态变化由 scene 监听 charStore.currentScreenPose 自动重排。
 */
import { ref } from 'vue'
import { useCharacterStore, useLive2DController } from '../character'
import { useLive2DScene } from '../character/live2d/scene'
import { setAgentLive2DController, setAgentLive2DManifest } from '../agent'
import { startLive2DMask, stopLive2DMask } from '../passthrough/live2dMask'
import { setVoicePlayer } from '../tts'

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const charStore = useCharacterStore()
const controller = useLive2DController()
const containerRef = ref<HTMLElement>()
const canvasRef = ref<HTMLCanvasElement>()

const scene = useLive2DScene(
  canvasRef,
  containerRef,
  {
    id: () => charStore.currentId,
    config: () => charStore.data?.live2d,
    screenPose: () => charStore.currentScreenPose,
  },
  {
    onReady: (sprite, manifest) => {
      controller.attach(sprite, manifest)
      setAgentLive2DController(controller)
      setAgentLive2DManifest(manifest)
      setVoicePlayer((url, signal) => controller.speakVoice(url, signal)) // TTS 口型同步
      startLive2DMask()
    },
    onDispose: () => {
      controller.detach()
      setAgentLive2DController(null)
      setAgentLive2DManifest(null)
      setVoicePlayer(null)
      stopLive2DMask()
    },
  },
)
const ready = scene.ready

function handleClick(e: MouseEvent) {
  emit('click', e)
}

defineExpose({ ready })
</script>

<template>
  <div ref="containerRef" class="live2d-container" @click="handleClick">
    <canvas ref="canvasRef" class="live2d-canvas" />
  </div>
</template>

<style scoped>
.live2d-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  contain: layout style paint;
}

.live2d-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
