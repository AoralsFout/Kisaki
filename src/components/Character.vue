<script setup lang="ts">
/**
 * 角色立绘渲染组件
 *
 * 双图叠加实现交叉淡入淡出 + 姿态系统（位置/缩放）。
 *
 * 姿态控制：
 * - controller.setPose('headshot-center') → 头像居中
 * - controller.setPose('full-bottom-left') → 全身左下
 * - 切换时 CSS transition 驱动平滑移动动画
 *
 * 图片切换：
 * - 旧图叠加在上层淡出（opacity 1→0）
 * - 新图在下层始终保持显示
 */
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue'
import { useCharacterController, registerCharacterController } from '../character'
import type { CharacterImageData } from '../character'

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const controller = useCharacterController()
const charStore = controller.charStore

/** 根据文件名生成完整 URL */
function imgUrl(file: string | undefined): string {
  return file ? charStore.getImageUrl(file) : ''
}

/** 正在淡出的旧图 */
const fadingImage = ref<CharacterImageData | null>(null)
/** 是否已触发淡出 */
const fading = ref(false)

/** 图片预加载：提前加载当前选中图片到浏览器缓存 */
function preloadImage(file: string | undefined) {
  if (!file) return
  const url = charStore.getImageUrl(file)
  const img = new Image()
  img.src = url
}

/** 监听当前图片变更，预加载新图 */
watch(
  () => controller.currentImage.value?.file,
  (newFile) => {
    if (newFile) preloadImage(newFile)
  },
)

/** 根据当前姿态计算 CSS 样式 */
const imageStyle = computed(() => {
  const pose = controller.screenPosePreset.value
  return {
    left: pose.left,
    bottom: pose.bottom,
    transform: `translateX(${pose.translateX}) scale(${pose.scale})`,
  }
})

onMounted(() => {
  controller.init()
  registerCharacterController(controller)
})

onUnmounted(() => {
  controller.dispose()
})

/** 监听图片切换，驱动交叉淡出 */
watch(
  () => controller.currentImage.value,
  (newImg, oldImg) => {
    if (!oldImg || !newImg || oldImg.file === newImg.file) return

    fadingImage.value = null
    fading.value = false

    nextTick(() => {
      fadingImage.value = oldImg

      requestAnimationFrame(() => {
        fading.value = true
      })
    })
  },
)

function onFadeEnd() {
  fadingImage.value = null
  fading.value = false
}

function handleClick(e: MouseEvent) {
  emit('click', e)
}

defineExpose({ controller })
</script>

<template>
  <div class="character-container" @click="handleClick">
    <!-- 当前图（底层，始终保持显示） -->
    <img v-if="controller.currentImage.value" :src="imgUrl(controller.currentImage.value?.file)" :style="imageStyle"
      class="img-base" :alt="controller.currentEmotion.value" draggable="false" />

    <!-- 旧图（叠在上层，淡出） -->
    <img v-if="fadingImage" :key="fadingImage.file" :src="imgUrl(fadingImage.file)"
      :style="[imageStyle, { position: 'absolute' }]" :class="['img-overlay', { 'fade-out': fading }]" alt=""
      draggable="false" @transitionend="onFadeEnd" />
  </div>
</template>

<style scoped>
.character-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  mask-image: linear-gradient(to left,#00000000 0%,#000 20%,#000 80%,#00000000 100%);
  /* mask-image: linear-gradient(to bottom,#00000000 0%,#000 20%,#000 80%,#00000000 100%); */
}

.img-base {
  position: absolute;
  height: 100%;
  object-fit: contain;
  pointer-events: none;

  /* 位置/缩放过渡（平滑动画） */
  transition:
    left 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    bottom 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    scale 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}

.img-overlay {
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  opacity: 1;
  z-index: 2;
}

.img-overlay.fade-out {
  opacity: 0;
  transition:
    opacity 0.5s ease,
    left 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    bottom 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.6s cubic-bezier(0.22, 1, 0.36, 1),
    scale 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}
</style>
