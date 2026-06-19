/**
 * Live2D 场景组合式 —— 加载/渲染/变换核心
 *
 * 把「CubismSetting+redirectPath 加载 + pixi app + sprite + 变换 + 生命周期」抽出，
 * 供桌宠（Live2DStage）与编辑器预览（Live2DPreview）共用。调用方通过 source 提供
 * 响应式的 id / live2d 配置 / 屏幕姿态；通过 options.onReady 叠加各自的副作用
 * （桌宠：注册控制器 + 穿透掩码；预览：无）。
 *
 * asset:// 加载必须用 CubismSetting + redirectPath（见设计 §10.1）；app 用
 * preserveDrawingBuffer 以便穿透掩码读取主画布 alpha（§10.2）。
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import { Config, CubismSetting, Live2DSprite, LogLevel, Priority } from 'easy-live2d'
import { Application, Ticker } from 'pixi.js'
import { loadLive2DManifest, live2dRedirect } from './manifest'
import type { Live2DManifest } from './manifest'
import type { Live2DConfig } from '../loader'
import { getPose } from '../poses'
import type { PoseKey } from '../poses'
import { createLogger } from '../../utils/logger'

const log = createLogger('Live2DScene')

export interface Live2DSceneSource {
  /** 当前角色 id */
  id: () => string
  /** 当前 live2d 配置（响应式 getter） */
  config: () => Live2DConfig | undefined
  /** 当前屏幕姿态预设 */
  screenPose: () => PoseKey
}

export interface Live2DSceneOptions {
  /** 模型 ready 后回调（桌宠用来注册控制器/掩码；预览不传） */
  onReady?: (sprite: Live2DSprite, manifest: Live2DManifest) => void
  /** 卸载时回调（桌宠用来解绑控制器/掩码） */
  onDispose?: () => void
}

export function useLive2DScene(
  canvasRef: Ref<HTMLCanvasElement | undefined>,
  containerRef: Ref<HTMLElement | undefined>,
  source: Live2DSceneSource,
  options: Live2DSceneOptions = {},
) {
  const ready = ref(false)
  let app: Application | null = null
  let sprite: Live2DSprite | null = null
  let manifest: Live2DManifest | null = null
  let disposed = false
  let loadToken = 0

  /** 按高度铺满（×scale），水平按屏幕姿态预设对齐、底部对齐 */
  function applyTransform() {
    if (!sprite || !containerRef.value) return
    const live2d = source.config()
    const preset = getPose(source.screenPose())
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

  async function setupModel() {
    const live2d = source.config()
    const id = source.id()
    if (!live2d?.model || !id) return
    const token = ++loadToken
    ready.value = false

    let mf: Live2DManifest
    try {
      mf = await loadLive2DManifest(id, { live2d })
    } catch (e) {
      log.error('加载 Live2D 清单失败: %s', (e as Error).message)
      return
    }
    if (disposed || token !== loadToken || !canvasRef.value) return
    manifest = mf

    if (sprite) {
      try { if (app) app.stage.removeChild(sprite); sprite.destroy() } catch { /* ignore */ }
      sprite = null
    }

    Config.MotionGroupIdle = mf.idleGroup
    Config.MouseFollow = live2d.mouseFollow ?? true
    Config.CubismLoggingLevel = LogLevel.LogLevel_Off

    const s = new Live2DSprite()
    const setting = new CubismSetting({ modelJSON: mf.modelJSON })
    setting.redirectPath(({ file }) => live2dRedirect(mf, file))
    s.init({ modelSetting: setting, ticker: Ticker.shared, draggable: false })
    sprite = s

    if (!app) {
      app = new Application()
      await app.init({
        canvas: canvasRef.value,
        backgroundAlpha: 0,
        preserveDrawingBuffer: true,
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
      options.onReady?.(s, mf)
      log.info('Live2D scene ready: %s (idle=%s)', id, mf.idleGroup)
    })
    s.onLive2D('hit', () => {
      if (manifest?.tapGroup && sprite) {
        void sprite.startMotion({ group: manifest.tapGroup, no: 0, priority: Priority.Normal })
      }
    })
  }

  // 模型/idle/tap/mouseFollow 或角色变化 → 重载；缩放/偏移/屏幕姿态 → 仅重排
  watch(
    () => [source.id(), source.config()?.model, source.config()?.idleMotionGroup,
      source.config()?.tapMotionGroup, source.config()?.mouseFollow],
    () => { void setupModel() },
  )
  watch(
    () => [source.config()?.scale, source.config()?.offsetX, source.config()?.offsetY, source.screenPose()],
    applyTransform,
  )
  window.addEventListener('resize', applyTransform)

  void setupModel() // 初始加载

  onUnmounted(() => {
    disposed = true
    window.removeEventListener('resize', applyTransform)
    options.onDispose?.()
    try { sprite?.destroy() } catch { /* ignore */ }
    try { app?.destroy() } catch { /* ignore */ }
    sprite = null
    app = null
  })

  return {
    ready,
    getSprite: () => sprite,
    getManifest: () => manifest,
    reload: () => { void setupModel() },
  }
}
