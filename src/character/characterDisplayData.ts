/**
 * 角色列表使用的只读显示投影。
 *
 * 列表不需要加载完整的 CharacterData；所有需要展示角色的界面都应该消费
 * 这份投影，以保证名称缺省规则和渲染方式的判断只有一个 Owner。
 */
import type { CharacterSummary, RenderKind } from './loader'

export interface CharacterDisplayData {
  readonly id: string
  readonly name: string
  readonly render: RenderKind
}

/** 角色没有显式名称时沿用既有的显示规则。 */
export function getCharacterDisplayName(id: string, name?: string | null): string {
  return name || id.charAt(0).toUpperCase() + id.slice(1)
}

/** 未知渲染类型按旧角色的默认行为作为静态立绘处理。 */
export function getCharacterDisplayRender(render?: RenderKind | null): RenderKind {
  return render === 'live2d' ? 'live2d' : 'illustration'
}

/** 将后端轻量摘要转换为列表可消费的只读显示数据。 */
export function toCharacterDisplayData(summary: CharacterSummary): CharacterDisplayData {
  return Object.freeze({
    id: summary.id,
    name: getCharacterDisplayName(summary.id, summary.name),
    render: getCharacterDisplayRender(summary.render),
  })
}

/** 将一次扫描结果投影为新的列表快照。 */
export function toCharacterDisplayList(summaries: readonly CharacterSummary[]): readonly CharacterDisplayData[] {
  return Object.freeze(summaries.map(toCharacterDisplayData))
}

/** 兼容仍只持有角色 ID 的旧调用方；正式列表应优先使用摘要投影。 */
export function displayDataFromIds(ids: readonly string[]): readonly CharacterDisplayData[] {
  return toCharacterDisplayList(ids.map(id => ({ id })))
}
