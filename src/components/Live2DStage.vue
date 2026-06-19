<script setup lang="ts">
/**
 * Live2D 渲染舞台
 *
 * 用 easy-live2d + pixi v8 渲染当前角色的 Live2D 模型。关键点（见设计 §10 spike 结论）：
 * - 模型经 data_dir 的 asset:// 加载：用 CubismSetting + redirectPath 逐文件重定向，
 *   不能直接传 modelPath（Windows 下相对路径解析失效）。
 * - app.init 传 preserveDrawingBuffer:true，供穿透掩码读取主画布 alpha（Phase 5）。
 *
 * 模型 ready 后创建并注册 Live2D 控制器（set_expression / play_motion / set_screen_pose
 * 由 AI 工具经 agent 上下文调用）。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Config, CubismSetting, Live2DSprite, LogLevel, Priority } from 'easy-live2d'
import { Application, Ticker } from 'pixi.js'
import { useCharacterStore, loadLive2DManifest, live2dRedirect, useLive2DController, getPose } from '../character'
import type { Live2DManifest } from '../character'
import { setAgentLive2DController, setAgentLive2DManifest } from '../agent'
import { startLive2DMask, stopLive2DMask } from '../passthrough/live2dMask'
import { createLogger } from '../utils/logger'

const log = createLogger('Live2DStage')

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const charStore = useCharacterStore()
const controller = useLive2DController()
const containerRef = ref<HTMLElement>()
const canvasRef = ref<HTMLCanvasElement>()
const ready = ref(false)

let app: Application | null = null
let sprite: Live2DSprite | null = null
let manifest: Live2DManifest | null = null
let disposed = false
/** 自增令牌：切换角色时让上一次未完成的加载失效，避免竞态 */
let loadToken = 0

/**
 * 放置 sprite：按高度铺满（× 角色基准 scale），水平按屏幕姿态预设（左/中/右）对齐、
 * 底部对齐。屏幕姿态的缩放/构图（半身/头像）后续增强，当前仅水平定位。
 */
function applyTransform() {
  if (!sprite || !containerRef.value) return
  const live2d = charStore.data?.live2d
  const preset = getPose(charStore.currentScreenPose)
  const scale = live2d?.scale ?? 1
  const cw = containerRef.value.clientWidth || window.innerWidth
  const ch = containerRef.value.clientHeight || window.innerHeight
  const size = sprite.getModelCanvasSize?.()
  const aspect = size && size.height ? size.width / size.height : cw / ch
  const sh = ch * scale
  const sw = sh * aspect
  const hx = preset.key.includes('left') ? 0 : preset.key.includes('right') ? 1 : 0.5
  sprite.width = sw
  sprite.height = sh
  sprite.x = (cw - sw) * hx + (live2d?.offsetX ?? 0)
  sprite.y = (ch - sh) + (live2d?.offsetY ?? 0)
}

/** （重新）加载当前角色的 Live2D 模型 */
async function setupModel() {
  const data = charStore.data
  if (!data?.live2d) return
  const id = charStore.currentId
  const token = ++loadToken
  ready.value = false

  let mf: Live2DManifest
  try {
    mf = await loadLive2DManifest(id, data)
  } catch (e) {
    log.error('加载 Live2D 清单失败: %s', (e as Error).message)
    return
  }
  if (disposed || token !== loadToken || !canvasRef.value) return
  manifest = mf
  setAgentLive2DManifest(mf) // 让 registry 能注入表情/动作枚举（ready 前也可用）

  // 切换角色：销毁旧 sprite
  if (sprite) {
    try { if (app) app.stage.removeChild(sprite); sprite.destroy() } catch { /* ignore */ }
    sprite = null
  }

  const live2d = data.live2d
  Config.MotionGroupIdle = mf.idleGroup
  Config.MouseFollow = live2d.mouseFollow ?? true
  Config.CubismLoggingLevel = LogLevel.LogLevel_Off

  const s = new Live2DSprite()
  const setting = new CubismSetting({ modelJSON: mf.modelJSON })
  setting.redirectPath(({ file }) => live2dRedirect(mf, file))
  s.init({ modelSetting: setting, ticker: Ticker.shared, draggable: false })
  sprite = s

  // 首次创建 pixi Application（后续切换角色复用同一个 app）
  if (!app) {
    app = new Application()
    await app.init({
      canvas: canvasRef.value,
      backgroundAlpha: 0,
      preserveDrawingBuffer: true, // 供穿透掩码读取主画布 alpha
      autoDensity: true,
      resizeTo: containerRef.value,
      resolution: Math.max(window.devicePixelRatio || 1, 1),
    })
  }
  if (disposed || token !== loadToken) { try { s.destroy() } catch { /* ignore */ } return }

  app.stage.addChild(s)
  applyTransform()

  s.onLive2D('ready', () => {
    if (token !== loadToken) return
    ready.value = true
    applyTransform()
    controller.attach(s, mf, { onScreenPose: applyTransform })
    setAgentLive2DController(controller)
    startLive2DMask() // 启动穿透掩码定期快照
    log.info('Live2D 模型 ready: %s (idle=%s)', id, mf.idleGroup)
  })
  s.onLive2D('hit', () => {
    if (manifest?.tapGroup && sprite) {
      void sprite.startMotion({ group: manifest.tapGroup, no: 0, priority: Priority.Normal })
    }
  })
}

onMounted(setupModel)

// 切换到另一个 Live2D 角色时重载模型
watch(() => charStore.currentId, () => {
  if (charStore.render === 'live2d') void setupModel()
})

// 屏幕姿态变化（会话恢复 / set_screen_pose）时重新适配变换
watch(() => charStore.currentScreenPose, applyTransform)

window.addEventListener('resize', applyTransform)

onUnmounted(() => {
  disposed = true
  window.removeEventListener('resize', applyTransform)
  controller.detach()
  setAgentLive2DController(null)
  setAgentLive2DManifest(null)
  stopLive2DMask()
  try { sprite?.destroy() } catch { /* ignore */ }
  try { app?.destroy() } catch { /* ignore */ }
  sprite = null
  app = null
})

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
