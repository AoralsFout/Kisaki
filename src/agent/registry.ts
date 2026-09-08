/**
 * 工具注册中心
 *
 * 管理所有可用工具，提供注册、查找、列出等功能。
 * getDefinitions() 会动态注入当前角色可用值到工具参数定义中。
 */
import type { Tool, ToolDefinition, ToolOutput } from './types'
import type { CharacterData } from '../character/loader'
import { getAgentCharData, getAgentLive2DManifest } from './context'
import { getCommandEnabled, getScreenCaptureEnabled, requiresWorkspace, SCREEN_CAPTURE_TOOL_NAME } from './toolPolicy'
import { EXPERIMENTAL_COMMAND_AVAILABLE } from '../constants'
import { createLogger } from '../utils/logger'

const log = createLogger('AgentRegistry')

/** 工具注册表 */
type RegisteredTool = Tool<string | ToolOutput>

const tools = new Map<string, RegisteredTool>()

/** 注册一个工具 */
export function register(tool: RegisteredTool) {
  tools.set(tool.definition.function.name, tool)
}

/** 批量注册 */
export function registerAll(...toolList: RegisteredTool[]) {
  for (const t of toolList) register(t)
  log.debug("agent_registry.register_all.debug", `批量注册 ${toolList.length} 个工具`, { tool_list_length: toolList.length })
}

/** 按名称获取工具 */
export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name)
}

/**
 * 获取所有工具定义。①按当前角色 render 类型过滤（appliesTo）；
 * ②动态注入可用枚举值：立绘用 emotions/poses/costumes，Live2D 用 manifest 的表情/动作。
 */
export function getDefinitions(
  charData?: CharacterData | null,
  options: { hasWorkspace?: boolean } = {},
): ToolDefinition[] {
  const resolved = charData ?? getAgentCharData()
  const render = resolved?.render ?? 'illustration'
  const manifest = getAgentLive2DManifest()

  const defs: ToolDefinition[] = []
  for (const t of tools.values()) {
    const toolName = t.definition.function.name
    // ① 按渲染类型过滤：appliesTo 为 'both'（默认）或与当前 render 一致才纳入
    const appliesTo = t.appliesTo ?? 'both'
    if (appliesTo !== 'both' && appliesTo !== render) continue

    // 没有工作区能力时不把文件/命令工具发送给模型，减少 token 和误调用。
    if (options.hasWorkspace === false && requiresWorkspace(toolName)) continue

    // ② 任务执行默认关闭（无 OS 沙箱、风险最高），需用户在设置中显式开启
    if (
      ['run_process', 'run_shell'].includes(toolName)
      && (!EXPERIMENTAL_COMMAND_AVAILABLE || !getCommandEnabled())
    ) continue

    // 截屏工具默认不暴露；用户开启后，每次调用仍须经过专用确认卡。
    if (
      toolName === SCREEN_CAPTURE_TOOL_NAME
      && !getScreenCaptureEnabled()
    ) continue

    const def = JSON.parse(JSON.stringify(t.definition))
    const props = def.function?.parameters?.properties

    if (props) {
      // ② 立绘枚举注入
      if (resolved) {
        if (props.emotion && resolved.emotions?.length) {
          props.emotion.enum = [...resolved.emotions]
          props.emotion.description = `可选: ${resolved.emotions.join('、')}`
        }
        if (props.stance && resolved.poses?.length) {
          props.stance.enum = [...resolved.poses]
          props.stance.description = `可选: ${resolved.poses.join('、')}`
        }
        if (props.costume && resolved.costumes?.length) {
          props.costume.enum = [...resolved.costumes]
          props.costume.description = `可选: ${resolved.costumes.join('、')}`
        }
      }
      // ② Live2D 枚举注入（从 manifest 自动发现的表情/动作 + 描述）
      if (manifest) {
        if (props.expression && manifest.expressions.length) {
          props.expression.enum = manifest.expressions.map(e => e.id)
          props.expression.description = `可选表情: ${manifest.expressions.map(e => `${e.id}(${e.desc})`).join('、')}`
        }
        if (props.motion && manifest.motions.length) {
          props.motion.enum = manifest.motions.map(m => m.group)
          props.motion.description = `可选动作: ${manifest.motions.map(m => `${m.group}(${m.desc})`).join('、')}`
        }
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
