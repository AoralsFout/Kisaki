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
import { SAY_TOOL_DEF } from '../../domain/tools/say'

import type { ToolCatalogContext, ToolDefinition } from '../../domain/tools/contracts'

/**
 * 装配本回合的工具清单：角色可见的工具定义，末尾补上 say 说话工具。
 *
 * `workspaceGrantId` 由调用方现取；清单只在 registry 使用点派生可见性。
 */
export function assembleRoundToolList(
  tools: { definitions(context: ToolCatalogContext): ToolDefinition[] },
  character: Pick<ToolCatalogContext, 'data' | 'capabilities'>,
  workspaceGrantId: string | null,
): ToolDefinition[] {
  return [
    ...tools.definitions({
      data: character.data,
      capabilities: character.capabilities,
      workspaceGrantId,
    }),
    SAY_TOOL_DEF,
  ]
}
