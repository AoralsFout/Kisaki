/**
 * Live2D 模型清单（manifest）
 *
 * 从 .model3.json 自动发现表情(expression)与动作(motion)，与 character.json 的
 * live2d 注解合并出给 AI 用的清单；同时返回解析后的 modelJSON 与相对目录，供
 * Live2DStage 用 `CubismSetting + redirectPath` 加载（asset:// 逐文件重定向）。
 *
 * 背景：Windows 下 convertFileSrc 把整条路径编码为单段，Cubism 自带相对路径解析
 * 失效，故每个引用文件都要单独 convertFileSrc（见 live2dRedirect / loader.live2dFileUrl）。
 */
import type { Live2DConfig } from '../loader'
import { live2dFileUrl } from '../loader'
import { createLogger } from '../../utils/logger'

const log = createLogger('Live2DManifest')

export interface Live2DExpressionInfo { id: string; desc: string }
export interface Live2DMotionInfo { group: string; count: number; desc: string }

export interface Live2DManifest {
  /** 角色 id（redirectPath 解析时用） */
  charId: string
  /** model3.json 相对角色目录的路径 */
  modelRel: string
  /** 模型目录相对角色目录的路径（redirectPath 拼接基准） */
  modelRelDir: string
  /** model3.json 的 asset URL */
  modelUrl: string
  /** 解析后的 model3.json（构造 CubismSetting 用） */
  modelJSON: unknown
  /** 可用表情（自动发现 + 注解描述） */
  expressions: Live2DExpressionInfo[]
  /** 可用动作组（自动发现 + 注解描述） */
  motions: Live2DMotionInfo[]
  /** 空闲动作组 */
  idleGroup: string
  /** 点击反应动作组（可选） */
  tapGroup?: string
}

interface Live2DCatalog {
  expressions: Live2DExpressionInfo[]
  motions: Live2DMotionInfo[]
  idleGroup: string
  tapGroup?: string
}

/**
 * 纯函数：由解析后的 model3.json + live2d 注解构建表情/动作清单。
 * 自动发现的列表是合法值唯一来源；注解只补人类可读描述，缺注解则用原始 ID/组名。
 */
export function buildLive2DCatalog(modelJSON: any, live2d?: Live2DConfig): Live2DCatalog {
  const fr = modelJSON?.FileReferences ?? {}
  const exprAnno = live2d?.expressions ?? {}
  const motionAnno = live2d?.motions ?? {}

  // 表情：FileReferences.Expressions = [{ Name, File }, ...]（可能不存在）
  const expressions: Live2DExpressionInfo[] = (fr.Expressions ?? [])
    .map((e: any) => String(e?.Name ?? ''))
    .filter((id: string) => id.length > 0)
    .map((id: string) => ({ id, desc: exprAnno[id] || id }))

  // 动作：FileReferences.Motions = { group: [{File,...}, ...], ... }
  const motionsObj = fr.Motions ?? {}
  const motions: Live2DMotionInfo[] = Object.keys(motionsObj).map((group) => ({
    group,
    count: Array.isArray(motionsObj[group]) ? motionsObj[group].length : 0,
    desc: motionAnno[group] || group,
  }))

  const groupNames = motions.map((m) => m.group)
  const idleGroup = live2d?.idleMotionGroup
    || groupNames.find((g) => /idle/i.test(g))
    || groupNames[0]
    || 'Idle'
  const tapGroup = live2d?.tapMotionGroup
    || groupNames.find((g) => /tap/i.test(g))
    || undefined

  return { expressions, motions, idleGroup, tapGroup }
}

/** 加载并构建某角色的 Live2D 清单（fetch model3.json + 自动发现 + 注解合并） */
export async function loadLive2DManifest(
  charId: string,
  data: { live2d?: Live2DConfig },
): Promise<Live2DManifest> {
  const live2d = data.live2d
  if (!live2d?.model) throw new Error(`角色 ${charId} 缺少 live2d.model 配置`)

  const modelRel = live2d.model
  const slash = modelRel.lastIndexOf('/')
  const modelRelDir = slash >= 0 ? modelRel.slice(0, slash) : ''
  const modelUrl = live2dFileUrl(charId, modelRel)
  if (!modelUrl) throw new Error('data_dir 未就绪，无法定位 Live2D 模型')

  let modelJSON: any
  try {
    const resp = await fetch(modelUrl)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    modelJSON = await resp.json()
  } catch (err) {
    throw new Error(`加载 model3.json 失败 (${modelUrl}): ${(err as Error).message}`)
  }

  const catalog = buildLive2DCatalog(modelJSON, live2d)
  log.info('Live2D 清单: %s, %d 表情, %d 动作组, idle=%s, tap=%s',
    charId, catalog.expressions.length, catalog.motions.length, catalog.idleGroup, catalog.tapGroup ?? '无')

  return { charId, modelRel, modelRelDir, modelUrl, modelJSON, ...catalog }
}

/**
 * redirectPath 用：把模型内引用的相对文件名映射成各自的 asset URL。
 * Live2DStage 传给 `CubismSetting.redirectPath(({file}) => live2dRedirect(manifest, file))`。
 */
export function live2dRedirect(
  manifest: Pick<Live2DManifest, 'charId' | 'modelRelDir'>,
  file: string,
): string {
  const rel = manifest.modelRelDir ? `${manifest.modelRelDir}/${file}` : file
  return live2dFileUrl(manifest.charId, rel)
}
