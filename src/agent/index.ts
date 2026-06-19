/**
 * Agent 模块 - 统一导出
 */
export { register, registerAll, getTool, getDefinitions, listTools } from './registry'
export { parseToolCalls, executeToolCall, executeToolCalls } from './executor'
export type { Tool, ToolDefinition, ToolCall, ToolResult, ToolParameter } from './types'
export { setAgentCharData, setAgentController, setOnCharacterSwitched, setAgentLive2DController, setAgentLive2DManifest } from './context'
export { setAvailableCharacters } from './tools/character'
export { SAY_TOOL_DEF, SAY_TOOL_NAME } from './tools/say'

import { createLogger } from '../utils/logger'
import { registerAll, listTools } from './registry'
import { timeTool } from './tools/time'
import { weatherTool } from './tools/weather'
import { calculatorTool } from './tools/calculator'
import { setEmotionTool, setStanceTool, setCostumeTool, setLookTool, setScreenPoseTool, getStateTool, switchCharacterTool } from './tools/character'
import { setExpressionTool, playMotionTool } from './tools/live2d'
import { readFileTool, writeFileTool, appendFileTool, listDirTool, deleteFileTool, replaceLinesTool, insertLinesTool, deleteLinesTool, findFilesTool, searchInFilesTool } from './tools/files'
import { executeCommandTool } from './tools/command'

const log = createLogger('Agent')

/** 初始化所有内置工具 */
export function initTools() {
  registerAll(
    timeTool, weatherTool, calculatorTool,
    setEmotionTool, setStanceTool, setCostumeTool, setLookTool, setScreenPoseTool, getStateTool, switchCharacterTool,
    setExpressionTool, playMotionTool,
    readFileTool, writeFileTool, appendFileTool, listDirTool, deleteFileTool,
    replaceLinesTool, insertLinesTool, deleteLinesTool, findFilesTool, searchInFilesTool,
    executeCommandTool,
  )
  log.info('内置工具已注册 (%d 个)', listTools().length)
}
