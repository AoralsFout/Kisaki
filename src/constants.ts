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

/** TTS 开关状态 */
export const STORAGE_TTS_ENABLED = 'deskpet-tts-enabled'

/** 用户显示语言偏好 */
export const STORAGE_DISPLAY_LANGUAGE = 'deskpet-display-language'

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

// ─── 默认值 ───────────────────────────────────────────

/** 默认显示语言 */
export const DEFAULT_DISPLAY_LANGUAGE = 'zh-CN'

/** 默认 TTS 语音语言 */
export const DEFAULT_VOICE_LANGUAGE = 'ja-JP'

/** 默认文本语言 */
export const DEFAULT_TEXT_LANGUAGE = 'zh-CN'
