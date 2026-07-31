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
    const spans = scanTextCalls(text)
    if (!spans.length) return text.trim()
    let out = text
    for (const [start, end] of spans.reverse()) {
      out = out.slice(0, start) + out.slice(end)
    }
    return out.trim()
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

/**
 * 工具调用起始模式：`name({`。
 * 用「花括号深度匹配 + 字符串字面量感知」的扫描器解析参数，
 * 兼容嵌套 JSON（旧正则 `\{[^}]*\}` 遇到嵌套对象会解析失败）。
 */
const TOOL_CALL_NAME_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\{/g

/** 找到从 openIndex（指向 '{'）起匹配的 '}' 下标；无法闭合返回 -1 */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 扫描文本，返回所有 `name({...})` 的 [开始, 结束) 下标区间 */
function scanTextCalls(text: string): Array<[number, number]> {
  const re = new RegExp(TOOL_CALL_NAME_RE.source, 'g')
  const spans: Array<[number, number]> = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const argsStart = re.lastIndex - 1 // 指向 '{'
    const argsEnd = findMatchingBrace(text, argsStart)
    if (argsEnd < 0) continue
    // '}' 后须跟可选的空白与 ')'
    let i = argsEnd + 1
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] !== ')') {
      re.lastIndex = argsEnd + 1
      continue
    }
    spans.push([match.index, i + 1])
    // 跳过整个调用，避免把参数内部的内容误当新调用
    re.lastIndex = i + 1
  }
  return spans
}

function parseTextToolCalls(
  text: string,
  toolLookup: (name: string) => { definition: ToolDefinition } | undefined,
): ToolCall[] {
  const calls: ToolCall[] = []
  const re = new RegExp(TOOL_CALL_NAME_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const name = match[1]
    if (!toolLookup(name)) continue
    const argsStart = re.lastIndex - 1 // 指向 '{'
    const argsEnd = findMatchingBrace(text, argsStart)
    if (argsEnd < 0) continue
    // '}' 后须跟可选的空白与 ')'
    let i = argsEnd + 1
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] !== ')') {
      re.lastIndex = argsEnd + 1
      continue
    }
    const argsStr = text.slice(argsStart, argsEnd + 1)
    try {
      calls.push({
        id: `text_${Date.now()}_${calls.length}`,
        name,
        arguments: JSON.parse(argsStr),
      })
    } catch { /* skip */ }
    // 跳过整个调用，避免把参数内部的内容误当新调用
    re.lastIndex = i + 1
  }
  return calls
}

// ─── 初始化工具注册（模块加载时执行一次） ────────────────

import { initTools } from './index'
initTools()
log.info('Agent 服务初始化完成')
