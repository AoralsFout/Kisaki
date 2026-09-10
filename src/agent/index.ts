/**
 * Agent 模块 - 统一导出
 */
export { register, registerAll, getTool, getDefinitions, listTools } from './registry'
export { parseToolCalls, executeToolCall, executeToolCalls } from './executor'
export type { Tool, ToolDefinition, ToolCall, ToolResult, ToolParameter, ToolOutput, ToolImage } from './types'
export { SAY_TOOL_DEF, SAY_TOOL_NAME } from './tools/say'

import { createLogger } from '../utils/logger'
import { registerAll, listTools } from './registry'
import { timeTool } from './tools/time'
import { weatherTool } from './tools/weather'
import { calculatorTool } from './tools/calculator'
import { webSearchTool } from './tools/webSearch'
import { setEmotionTool, setStanceTool, setCostumeTool, setLookTool, setScreenPoseTool, getStateTool } from './tools/character'
import { setExpressionTool, playMotionTool } from './tools/live2d'
import { readFileTool, readImageTool, writeFileTool, appendFileTool, listDirTool, deleteFileTool, replaceLinesTool, insertLinesTool, deleteLinesTool, findFilesTool, searchInFilesTool } from './tools/files'
import { runProcessTool, runShellTool } from './tools/command'
import { captureScreenTool } from './tools/screenshot'

const log = createLogger('Agent')

/** 初始化所有内置工具 */
export function initTools() {
  registerAll(
    timeTool, weatherTool, calculatorTool, webSearchTool,
    setEmotionTool, setStanceTool, setCostumeTool, setLookTool, setScreenPoseTool, getStateTool,
    setExpressionTool, playMotionTool,
    readFileTool, readImageTool, writeFileTool, appendFileTool, listDirTool, deleteFileTool,
    replaceLinesTool, insertLinesTool, deleteLinesTool, findFilesTool, searchInFilesTool,
    captureScreenTool,
    runProcessTool, runShellTool,
  )
  log.info("agent.init_tools.info", `内置工具已注册 (${listTools().length} 个)`, { list_tools_length: listTools().length })
}
