/**
 * AI 模块 - 统一导出
 */
export { chat, quickChat, MAX_TOOL_TURNS, getModelProfile, loadConfig, saveConfig, saveConfigSecure, loadConfigSecure, isConfigValid, testAIConnection, DEFAULT_CONFIG } from './client'
export { DEFAULT_SYSTEM_PROMPT, getDefaultMessages } from './prompts'
export { ChatContext, ContextBudgetError } from './context'
export type { ChatContextSnapshot, ContextStats } from './context'
export { translateText } from './translate'
export { validateImageFiles, createImageAttachment, MAX_IMAGE_COUNT, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from './images'
export type { ImageValidationError, ImageValidationResult } from './images'
export type { AIConfig, ChatMessage, ChatMessageContent, ChatContentPart, ChatInputPayload, ImageAttachment, StreamCallbacks, MessageRole, ToolCallData, ResponseFormat } from './types'
export type { ModelProfile, ModelTier } from './modelCapabilities'
