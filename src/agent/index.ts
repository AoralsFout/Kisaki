/**
 * Agent 模块 - 统一导出
 */
export { register, registerAll, getTool, getDefinitions, listTools } from './registry'
export { parseToolCalls, executeToolCall, executeToolCalls } from './executor'
export type { Tool, ToolDefinition, ToolCall, ToolResult, ToolParameter } from './types'

import { registerAll } from './registry'
import { timeTool } from './tools/time'
import { weatherTool } from './tools/weather'
import { calculatorTool } from './tools/calculator'
import { setEmotionTool, setStanceTool, setCostumeTool, setLookTool, setScreenPoseTool, getStateTool, switchCharacterTool } from './tools/character'

/** 初始化所有内置工具 */
export function initTools() {
  registerAll(
    timeTool, weatherTool, calculatorTool,
    setEmotionTool, setStanceTool, setCostumeTool, setLookTool, setScreenPoseTool, getStateTool, switchCharacterTool,
  )
}
