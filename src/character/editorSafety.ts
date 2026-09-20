/**
 * 角色删除并刷新列表后，决定是否需要加载替代角色。
 *
 * 返回当前角色 id 表示无需切换，返回 null 表示角色列表为空。
 */
export function chooseCharacterAfterDelete(
  currentId: string,
  deletedId: string,
  availableList: readonly string[],
): string | null {
  if (currentId !== deletedId) return currentId
  return availableList[0] ?? null
}
