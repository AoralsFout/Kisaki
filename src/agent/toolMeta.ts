/**
 * 工具展示元信息 —— 工具名 → 图标
 *
 * 供主窗口「工具调用过程」列表使用。图标与语言无关，放在 TS 里；
 * 人类可读名称走 i18n（key: `app.tools.<toolName>`）。
 * 使用项目已引入的 Font Awesome free（`fas fa-*`）。
 */

/** 工具名 → Font Awesome 图标类（不含 `fas` 前缀） */
const TOOL_ICONS: Record<string, string> = {
  // 信息类
  get_time: 'fa-clock',
  get_weather: 'fa-cloud-sun',
  calculator: 'fa-calculator',
  web_search: 'fa-globe',
  // 角色动作类
  set_character_emotion: 'fa-face-smile',
  set_character_stance: 'fa-person',
  set_character_costume: 'fa-shirt',
  set_character_look: 'fa-wand-magic-sparkles',
  // Live2D 专属
  set_expression: 'fa-face-grin-stars',
  play_motion: 'fa-film',
  set_screen_pose: 'fa-up-down-left-right',
  get_character_state: 'fa-circle-info',
  switch_character: 'fa-rotate',
  // 命令执行
  execute_command: 'fa-terminal',
  // 文件类
  read_file: 'fa-file-lines',
  write_file: 'fa-file-pen',
  append_file: 'fa-file-circle-plus',
  list_dir: 'fa-folder-open',
  delete_file: 'fa-trash',
  // 按行编辑 / 查找
  replace_lines: 'fa-pen-to-square',
  insert_lines: 'fa-square-plus',
  delete_lines: 'fa-eraser',
  find_files: 'fa-magnifying-glass',
  search_in_files: 'fa-magnifying-glass-arrow-right',
}

/** 未知工具的兜底图标 */
const FALLBACK_ICON = 'fa-gear'

/** 取工具对应的图标类；未知工具返回兜底图标 */
export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? FALLBACK_ICON
}
