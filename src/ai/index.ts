/**
 * AI 模块 - 统一导出
 */
export { chat, quickChat, getToolTurns, getModelProfile, loadConfig, saveConfig, saveConfigSecure, loadConfigSecure, isConfigValid, DEFAULT_CONFIG } from './client'
export { DEFAULT_SYSTEM_PROMPT, getDefaultMessages } from './prompts'
export { ChatContext } from './context'
export { translateText } from './translate'
export type { AIConfig, ChatMessage, StreamCallbacks, MessageRole, ToolCallData, ResponseFormat } from './types'
export type { ModelProfile, ModelTier } from './modelCapabilities'
