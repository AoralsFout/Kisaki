/**
 * Agent 外观（Facade）
 *
 * 为 ChatStore 提供简洁的 Agent 操作接口，隐藏 registry、executor、
 * context 等内部细节。后续替换 Agent 实现时只需修改本文件。
 */
import type { ToolDefinition, ToolCall, ToolResult } from './types'
import type { CharacterData } from '../character/loader'
import { getDefinitions, getTool } from './registry'
import { executeToolCall } from './executor'
import { setAgentCharData } from './context'
import { setAvailableCharacters } from './tools/character'
import { createLogger } from '../utils/logger'

const log = createLogger('AgentSvc')

/** Agent 服务的公开接口 */
export interface AgentService {
  /** 获取所有工具定义（含角色枚举值注入） */
  getToolDefinitions(charData?: CharacterData | null): ToolDefinition[]
  /** 执行单个工具调用 */
  execute(tc: ToolCall): Promise<ToolResult>
  /** 从文本中提取工具调用（兜底方案） */
  extractTextToolCalls(text: string): ToolCall[]
  /** 从文本中移除工具调用 */
  stripTextToolCalls(text: string): string
  /** 同步角色数据到工具上下文 */
  syncCharacterData(data: CharacterData | null): void
  /** 同步可用角色列表 */
  syncAvailableCharacters(list: string[]): void
  /** 检查工具是否存在 */
  hasTool(name: string): boolean
}

/** 默认实现 */
export const agentService: AgentService = {
  getToolDefinitions(charData) {
    return getDefinitions(charData)
  },

  async execute(tc) {
    return executeToolCall(tc)
  },

  extractTextToolCalls(text) {
    return parseTextToolCalls(text, getTool)
  },

  stripTextToolCalls(text) {
    return text.replace(TEXT_TOOL_CALL_RE, '').trim()
  },

  syncCharacterData(data) {
    setAgentCharData(data)
  },

  syncAvailableCharacters(list) {
    setAvailableCharacters(list)
  },

  hasTool(name) {
    return getTool(name) !== undefined
  },
}

// ─── 文本工具调用提取（原 chat.ts 中的逻辑，迁移至此） ──────────

const TEXT_TOOL_CALL_RE = /(\w+)\s*\(\s*(\{[^}]*\})\s*\)/g

function parseTextToolCalls(
  text: string,
  toolLookup: (name: string) => { definition: ToolDefinition } | undefined,
): ToolCall[] {
  const calls: ToolCall[] = []
  const re = new RegExp(TEXT_TOOL_CALL_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const name = match[1]
    const argsStr = match[2]
    if (!toolLookup(name)) continue
    try {
      calls.push({
        id: `text_${Date.now()}_${calls.length}`,
        name,
        arguments: JSON.parse(argsStr),
      })
    } catch { /* skip */ }
  }
  return calls
}

// ─── 初始化工具注册（模块加载时执行一次） ────────────────

import { initTools } from './index'
initTools()
log.info('Agent 服务初始化完成')
