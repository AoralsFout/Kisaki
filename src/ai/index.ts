/**
 * AI 模块 - 统一导出
 */
export { chat, loadConfig, saveConfig, saveConfigSecure, loadConfigSecure, isConfigValid, DEFAULT_CONFIG } from './client'
export { DEFAULT_SYSTEM_PROMPT, getDefaultMessages } from './prompts'
export { ChatContext } from './context'
export type { AIConfig, ChatMessage, StreamCallbacks, MessageRole, ToolCallData } from './types'
