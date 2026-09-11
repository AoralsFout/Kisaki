/**
 * 一次回合发送给模型的工具清单装配。
 *
 * 装配**必须只有一处**：回合真正发送的清单，与设置页 `inspectContext()` 展示的清单，
 * 是同一份东西。两处各写一遍 `[...definitions(...), SAY_TOOL_DEF]` 时它们会在下一次
 * 改清单时漂移 —— 设置页显示的就不再是回合实际发送的。
 *
 * 它是一个独立的无框架小模块，而不是长在 `conversationSession.ts` 里：展示层要
 * import 它，而回合模块本身是按需动态加载的，不该被静态拽进启动路径。
 */
import { SAY_TOOL_DEF } from '../../agent/tools/say'

import type { ToolDefinition } from '../../agent/types'
import type { CharacterToolContext } from '../../agent/registry'
import type { CharacterData } from '../../character/loader'
import type { CharacterCapabilities } from '../character/characterRuntime'

/**
 * 装配本回合的工具清单：角色可见的工具定义，末尾补上 say 说话工具。
 *
 * `hasWorkspace` 由调用方现取（一个回合内用户可能中途授权），故不在这里读端口。
 */
export function assembleRoundToolList(
  tools: { definitions(context: CharacterToolContext): ToolDefinition[] },
  character: { data: CharacterData | null; capabilities: CharacterCapabilities | null },
  hasWorkspace: boolean,
): ToolDefinition[] {
  return [
    ...tools.definitions({
      data: character.data,
      capabilities: character.capabilities,
      hasWorkspace,
    }),
    SAY_TOOL_DEF,
  ]
}
