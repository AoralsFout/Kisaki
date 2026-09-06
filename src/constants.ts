/**
 * 应用全局常量
 *
 * 集中管理所有 localStorage key、窗口 label、BroadcastChannel 名、
 * URL 参数名等硬编码字符串，防止散落各处导致维护困难。
 */

// ─── localStorage 存储键 ──────────────────────────────

/** AI 配置（API Key, baseURL, model） */
export const STORAGE_AI_CONFIG = 'deskpet-ai-config'

/** CosyVoice TTS 配置（API Key, model, region） */
export const STORAGE_COSYVOICE_CONFIG = 'deskpet-cosyvoice-config'

/** GPT-SoVITS 本地 TTS 配置 */
export const STORAGE_GPTSOVITS_CONFIG = 'deskpet-gptsovits-config'

/** TTS 提供者选择：'none' | 'cosyvoice' | 'gptsovits' */
export const STORAGE_TTS_PROVIDER = 'deskpet-tts-provider'

/** TTS 开关状态 */
export const STORAGE_TTS_ENABLED = 'deskpet-tts-enabled'

/** 用户显示语言偏好（AI 回复文本翻译语言，区别于 UI 界面语言） */
export const STORAGE_DISPLAY_LANGUAGE = 'deskpet-display-language'

/** 用户界面语言偏好（UI 文案，区别于 AI 回复翻译语言） */
export const STORAGE_UI_LANGUAGE = 'deskpet-ui-language'

/** 鼠标穿透开关（透明区域点击穿透到下方窗口） */
export const STORAGE_PASSTHROUGH_ENABLED = 'deskpet-passthrough-enabled'

/** 悬浮角色时用滚轮调整透明度（默认开启） */
export const STORAGE_CHARACTER_OPACITY_WHEEL_ENABLED = 'deskpet-character-opacity-wheel-enabled'

/** 用户主动降低界面动画效果（系统 reduced-motion 偏好始终独立生效） */
export const STORAGE_REDUCED_MOTION = 'deskpet-reduced-motion'

/** 当前角色显示透明度 */
export const STORAGE_CHARACTER_OPACITY = 'deskpet-character-opacity'

/** 全局「自动执行文件修改」开关（开启后改文件工具跳过逐次确认） */
export const STORAGE_AUTO_EXEC_FILES = 'deskpet-auto-exec-files'

/** 全局「允许 AI 执行本地任务」开关（默认关闭，安全考量） */
export const STORAGE_COMMAND_ENABLED = 'deskpet-command-enabled'

/** 命令执行只在开发构建提供；正式构建由前后端双重禁用。 */
export const EXPERIMENTAL_COMMAND_AVAILABLE = import.meta.env.DEV

/** 联网搜索配置（provider, apiKey, baseURL, enabled） */
export const STORAGE_SEARCH_CONFIG = 'deskpet-search-config'

// ─── Tauri Webview 窗口标签 ──────────────────────────

/** 主窗口 */
export const WINDOW_MAIN = 'main'

/** 设置窗口 */
export const WINDOW_SETTINGS = 'settings'

/** 调试面板窗口 */
export const WINDOW_DEV = 'dev'

/** 日志窗口 */
export const WINDOW_LOGS = 'logs'

// ─── URL 查询参数名 ───────────────────────────────────

/** URL 参数：调试面板 */
export const QUERY_DEV = 'dev'

/** URL 参数：设置面板 */
export const QUERY_SETTINGS = 'settings'

/** URL 参数：日志查看器 */
export const QUERY_LOGS = 'logs'

// ─── BroadcastChannel 频道名 ──────────────────────────

/** 角色控制指令广播通道（DevPanel ↔ 主窗口） */
export const CHANNEL_DESKPET_DEV = 'deskpet-dev'

/** 跨窗口日志同步广播通道 */
export const CHANNEL_DESKPET_LOGS = 'deskpet-logs'

/** 界面语言切换广播通道（设置窗口切换后通知其它窗口实时联动） */
export const CHANNEL_DESKPET_UI_LANG = 'deskpet-ui-lang'

/** 降低动画效果切换广播通道（设置窗口 → 其它窗口） */
export const CHANNEL_DESKPET_REDUCED_MOTION = 'deskpet-reduced-motion'

// ─── Tauri 事件名（跨窗口，经 Rust 中转） ──────────────

/** 角色增删改后广播：通知主窗口刷新角色列表（设置窗口 → 主窗口） */
export const EVENT_CHARACTERS_CHANGED = 'characters-changed'

/** AI 服务或模型配置保存后广播：主窗口据此重建上下文预算。 */
export const EVENT_AI_CONFIG_CHANGED = 'ai-config-changed'

/** 设置窗口标签定位（主窗口/引导 → 设置窗口）：payload 为 { tab } */
export const EVENT_SETTINGS_NAVIGATE = 'settings-navigate'

/** Rust 端轮询的全局光标位置（物理屏幕坐标），主窗口据此做鼠标穿透命中测试 */
export const EVENT_CURSOR_POS = 'cursor-pos'

// ─── 默认值 ───────────────────────────────────────────

/** 默认显示语言 */
export const DEFAULT_DISPLAY_LANGUAGE = 'zh-CN'

/** 默认界面语言（UI 文案） */
export const DEFAULT_UI_LANGUAGE = 'zh-CN'

/** 默认 TTS 语音语言 */
export const DEFAULT_VOICE_LANGUAGE = 'ja-JP'

/** 默认文本语言 */
export const DEFAULT_TEXT_LANGUAGE = 'zh-CN'

/** 打字机显示速度（ms/字符） */
export const STORAGE_TYPING_SPEED = 'deskpet-typing-speed'
export const DEFAULT_TYPING_SPEED = 50

/** 首次运行引导是否已完成 */
export const STORAGE_ONBOARDING_DONE = 'deskpet-onboarding-done'

/** 首次运行引导被「稍后再说」搁置：不等于完成，配置待办仍可从主窗口恢复 */
export const STORAGE_ONBOARDING_DISMISSED = 'deskpet-onboarding-dismissed'

/** 会话列表存储键 */
export const STORAGE_SESSIONS = 'deskpet-sessions'

/** 当前会话 ID 存储键 */
export const STORAGE_CURRENT_SESSION = 'deskpet-current-session'
