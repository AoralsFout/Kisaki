/**
 * 工具注册中心
 *
 * 管理所有可用工具，提供注册、查找、列出等功能。
 * getDefinitions() 会动态注入当前角色可用值到工具参数定义中。
 */
import type { Tool, ToolDefinition } from './types'
import { useCharacterStore } from '../stores/character'

/** 工具注册表 */
const tools = new Map<string, Tool>()

/** 注册一个工具 */
export function register(tool: Tool) {
  tools.set(tool.definition.function.name, tool)
}

/** 批量注册 */
export function registerAll(...toolList: Tool[]) {
  for (const t of toolList) register(t)
}

/** 按名称获取工具 */
export function getTool(name: string): Tool | undefined {
  return tools.get(name)
}

/** 获取所有工具定义，自动注入当前角色的可用枚举值 */
export function getDefinitions(): ToolDefinition[] {
  let charData: any = null
  try {
    const store = useCharacterStore()
    if (store.data) charData = store.data
  } catch { /* Pinia 不可用 */ }

  const defs: ToolDefinition[] = []
  for (const t of tools.values()) {
    const def = JSON.parse(JSON.stringify(t.definition))
    const props = def.function?.parameters?.properties

    if (charData && props) {
      if (props.emotion && charData.emotions?.length) {
        props.emotion.enum = [...charData.emotions]
        props.emotion.description = `可选: ${charData.emotions.join('、')}`
      }
      if (props.stance && charData.poses?.length) {
        props.stance.enum = [...charData.poses]
        props.stance.description = `可选: ${charData.poses.join('、')}`
      }
      if (props.costume && charData.costumes?.length) {
        props.costume.enum = [...charData.costumes]
        props.costume.description = `可选: ${charData.costumes.join('、')}`
      }
    }

    defs.push(def)
  }
  return defs
}

/** 获取所有已注册的工具名 */
export function listTools(): string[] {
  return [...tools.keys()]
}

/** 工具数量 */
export function toolCount(): number {
  return tools.size
}
