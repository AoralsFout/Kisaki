/**
 * 模型能力注册表
 *
 * 集中管理各模型家族的上下文窗口、输出规模、智能层级等能力参数，
 * 供上下文管理（ChatContext）和 API 客户端按模型自动选择最优配置，
 * 替代原有的硬编码常量。
 *
 * ── 数据来源 ──
 * 2026-08-30 依据各厂商官方模型文档复核：
 * - OpenAI:    developers.openai.com/api/docs/models
 * - Anthropic: platform.claude.com/docs/en/models/overview
 * - Google:    ai.google.dev/gemini-api/docs/models
 * - DeepSeek:  api-docs.deepseek.com/quick_start/pricing
 * - Z.AI:      docs.z.ai/guides/overview/overview
 * - Kimi:      platform.kimi.ai/docs/models
 * - xAI:       docs.x.ai/developers/models
 * - Meta:      ai.meta.com/blog/llama-4-multimodal-intelligence
 * - Mistral:   docs.mistral.ai/models
 * - Qwen:      help.aliyun.com/zh/model-studio/text-generation-model
 *
 * recommendedMaxTokens 是本应用面向交互对话的保守默认值，不等于厂商公布的
 * 理论最大输出；上下文窗口和能力开关则以官方文档为准。退役模型仍保留兼容映射。
 */
import { createLogger } from '../utils/logger'

const log = createLogger('ModelCaps')

// ─── 类型 ──────────────────────────────────────────────

/** 模型智能层级（影响工具调用轮数等） */
export type ModelTier = 'low' | 'medium' | 'high' | 'very-high'

/** 模型能力画像 */
export interface ModelProfile {
  /** 模型家族代号（如 "gpt-4o"、"deepseek-v4-flash"） */
  family: string
  /** 总上下文窗口（token，含输入 + 输出） */
  maxContextWindow: number
  /**
   * 建议最大输出 token 数（用于 API max_tokens/max_completion_tokens 参数）。
   * 这是对话场景的合理上限，并非模型理论最大值。
   */
  recommendedMaxTokens: number
  /** 智能层级 */
  tier: ModelTier
  /** 是否支持 structured output（json_schema 严格模式） */
  supportsStructuredOutput: boolean
  /** 是否支持 json_object 模式 */
  supportsJsonMode: boolean
}

// ─── 注册表 ────────────────────────────────────────────

interface ModelEntry {
  pattern: RegExp
  profile: ModelProfile
}

/**
 * 模型注册表——顺序敏感，优先匹配靠前的条目。
 * pattern 匹配模型名前缀，越具体（如 gpt-4.1-mini）越靠前。
 *
 * 注册规则：
 * 1. 同一家族的更具体变体（mini/nano/chat/codex）排在通用条目之前
 * 2. 版本号更高的排列在其低版本之前（如 5.4 在 5.3 之前）
 * 3. 各家族之间顺序不重要
 */
const MODEL_REGISTRY: ModelEntry[] = [

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-5.6 系列：1.05M 上下文，128K 最大输出
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-5\.6-sol-/i,
    profile: {
      family: 'gpt-5.6-sol', maxContextWindow: 1_050_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.6-terra-/i,
    profile: {
      family: 'gpt-5.6-terra', maxContextWindow: 1_050_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.6-luna-/i,
    profile: {
      family: 'gpt-5.6-luna', maxContextWindow: 1_050_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  // gpt-5.6 是官方指向 Sol 的别名。
  {
    pattern: /^gpt-5\.6-/i,
    profile: {
      family: 'gpt-5.6-sol', maxContextWindow: 1_050_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-5.5 系列：1.05M 上下文，128K 最大输出
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-5\.5-pro-/i,
    profile: {
      family: 'gpt-5.5-pro', maxContextWindow: 1_050_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.5-/i,
    profile: {
      family: 'gpt-5.5', maxContextWindow: 1_050_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-5.4 系列：主模型 1.05M，Mini/Nano 400K；均支持 128K 输出
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-5\.4-mini-/i,
    profile: {
      family: 'gpt-5.4-mini', maxContextWindow: 400_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.4-nano-/i,
    profile: {
      family: 'gpt-5.4-nano', maxContextWindow: 400_000, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.4-/i,
    profile: {
      family: 'gpt-5.4', maxContextWindow: 1_050_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-5.3 系列 (2026-02)
  // 5.3 Chat: 128K 上下文, 5.3 Codex: 400K 上下文
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-5\.3-codex-/i,
    profile: {
      family: 'gpt-5.3-codex', maxContextWindow: 400_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.3-/i,  // 包括 gpt-5.3-chat-* 和 gpt-5.3-*
    profile: {
      family: 'gpt-5.3-chat', maxContextWindow: 128_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-5 系列 (2025-08 ~ 2026-01), 400K 上下文
  // GPT-5, 5.1, 5.2 均为 400K
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-5\.2-/i,
    profile: {
      family: 'gpt-5.2', maxContextWindow: 400_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5\.1-/i,
    profile: {
      family: 'gpt-5.1', maxContextWindow: 400_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5-codex-/i,
    profile: {
      family: 'gpt-5-codex', maxContextWindow: 400_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5-mini-/i,
    profile: {
      family: 'gpt-5-mini', maxContextWindow: 400_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5-nano-/i,
    profile: {
      family: 'gpt-5-nano', maxContextWindow: 400_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-5-/i,
    profile: {
      family: 'gpt-5', maxContextWindow: 400_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI o-series 推理模型
  // o1/o3/o4-mini: 200K 上下文, 100K max_completion_tokens
  // 注意：需用 max_completion_tokens 而非 max_tokens
  // ════════════════════════════════════════════════════════
  {
    pattern: /^o1-/i,
    profile: {
      family: 'o1', maxContextWindow: 200_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^o3-/i,
    profile: {
      family: 'o3', maxContextWindow: 200_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^o4-mini-/i,
    profile: {
      family: 'o4-mini', maxContextWindow: 200_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-4.1 系列 (2025-04)
  // 1M 上下文, 32K max output
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-4\.1-nano-/i,
    profile: {
      family: 'gpt-4.1-nano', maxContextWindow: 1_047_576, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-4\.1-mini-/i,
    profile: {
      family: 'gpt-4.1-mini', maxContextWindow: 1_047_576, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-4\.1-/i,
    profile: {
      family: 'gpt-4.1', maxContextWindow: 1_047_576, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-4.5
  // 128K 上下文
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-4\.5-/i,
    profile: {
      family: 'gpt-4.5', maxContextWindow: 128_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-4o / 4o-mini
  // 均为 128K 上下文
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-4o-mini-/i,
    profile: {
      family: 'gpt-4o-mini', maxContextWindow: 128_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-4o-/i,
    profile: {
      family: 'gpt-4o', maxContextWindow: 128_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-4-Turbo / GPT-4 (legacy)
  // GPT-4-Turbo: 128K, GPT-4: 8K
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-4-turbo-/i,
    profile: {
      family: 'gpt-4-turbo', maxContextWindow: 128_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gpt-4-/i,
    profile: {
      family: 'gpt-4', maxContextWindow: 8_192, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // OpenAI GPT-3.5 (legacy)
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gpt-3\.5-/i,
    profile: {
      family: 'gpt-3.5', maxContextWindow: 16_385, recommendedMaxTokens: 2_048,
      tier: 'low', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // Z.AI GLM 系列
  // GLM-5.2/5.3：1M 上下文；GLM-5/4.6/4.7：200K；GLM-4.5：128K。
  // 5.x/4.6/4.7 最大输出 128K，4.5 系列最大输出 96K。
  // ════════════════════════════════════════════════════════
  {
    pattern: /^glm-5\.3-flash-/i,
    profile: {
      family: 'glm-5.3-flash', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-5\.3-/i,
    profile: {
      family: 'glm-5.3', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-5\.2-/i,
    profile: {
      family: 'glm-5.2', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-5\.1-/i,
    profile: {
      family: 'glm-5.1', maxContextWindow: 200_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-5-/i,
    profile: {
      family: 'glm-5', maxContextWindow: 200_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-4\.7-(flashx|flash)-/i,
    profile: {
      family: 'glm-4.7-flash', maxContextWindow: 200_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-4\.7-/i,
    profile: {
      family: 'glm-4.7', maxContextWindow: 200_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-4\.6-/i,
    profile: {
      family: 'glm-4.6', maxContextWindow: 200_000, recommendedMaxTokens: 32_768,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-4\.5-flash-/i,
    profile: {
      family: 'glm-4.5-flash', maxContextWindow: 200_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-4\.5-/i,
    profile: {
      family: 'glm-4.5', maxContextWindow: 128_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^glm-/i,
    profile: {
      family: 'glm', maxContextWindow: 128_000, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // Moonshot AI Kimi 系列
  // Kimi K3：1M；K2.7 Code/K2.6/K2.5：256K；Moonshot V1 按型号区分。
  // K2 预览系列已退役，但保留能力映射以兼容旧配置。
  // ════════════════════════════════════════════════════════
  {
    pattern: /^kimi-k3(?:\[1m\])?-/i,
    profile: {
      family: 'kimi-k3', maxContextWindow: 1_048_576, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^kimi-k2\.7-code-highspeed-/i,
    profile: {
      family: 'kimi-k2.7-code-highspeed', maxContextWindow: 262_144, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^kimi-k2\.7-code-/i,
    profile: {
      family: 'kimi-k2.7-code', maxContextWindow: 262_144, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^kimi-k2\.(6|5)-/i,
    profile: {
      family: 'kimi-k2.x', maxContextWindow: 262_144, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^kimi-k2-0711-preview-/i,
    profile: {
      family: 'kimi-k2-0711', maxContextWindow: 131_072, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^kimi-k2-/i,
    profile: {
      family: 'kimi-k2', maxContextWindow: 262_144, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^kimi-latest-/i,
    profile: {
      family: 'kimi-legacy', maxContextWindow: 131_072, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^moonshot-v1-128k-/i,
    profile: {
      family: 'moonshot-v1-128k', maxContextWindow: 131_072, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^moonshot-v1-32k-/i,
    profile: {
      family: 'moonshot-v1-32k', maxContextWindow: 32_768, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^moonshot-v1-8k-/i,
    profile: {
      family: 'moonshot-v1-8k', maxContextWindow: 8_192, recommendedMaxTokens: 2_048,
      tier: 'low', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // DeepSeek V4 系列：1M 上下文，384K 最大输出，支持 JSON Output
  //
  // 注意: deepseek-chat 与 deepseek-reasoner 为旧别名，
  // 将于 2026-07-24 退役，当前路由到 V4 Flash。
  // ════════════════════════════════════════════════════════
  {
    pattern: /^deepseek-v4-pro/i,
    profile: {
      family: 'deepseek-v4-pro', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^deepseek-v4-flash/i,
    profile: {
      family: 'deepseek-v4-flash', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^deepseek-v4-/i,
    profile: {
      family: 'deepseek-v4', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },

  // DeepSeek 旧版别名 → 当前均路由到 V4 Flash
  {
    pattern: /^deepseek-reasoner/i,
    profile: {
      family: 'deepseek-reasoner', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },
  {
    pattern: /^deepseek-chat/i,
    profile: {
      family: 'deepseek-chat', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },

  // DeepSeek V3/R1 (legacy, 128K 上下文)
  {
    pattern: /^deepseek-/i,
    profile: {
      family: 'deepseek-legacy', maxContextWindow: 128_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: true,
    },
  },

  // ════════════════════════════════════════════════════════
  // Anthropic Claude 系列
  // Claude 5 当前阵容：Fable/Opus/Sonnet 均为 1M 上下文、128K 最大输出。
  // Claude Haiku 4.5：200K 上下文、64K 最大输出。
  // ════════════════════════════════════════════════════════

  {
    pattern: /^claude-fable-5-/i,
    profile: {
      family: 'claude-fable-5', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^claude-opus-5-/i,
    profile: {
      family: 'claude-opus-5', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^claude-sonnet-5-/i,
    profile: {
      family: 'claude-sonnet-5', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^claude-mythos-5-/i,
    profile: {
      family: 'claude-mythos-5', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // Claude 4.x — 具体型号优先于 generic 4
  {
    pattern: /^claude-opus-4-(8|7)-/i,
    profile: {
      family: 'claude-opus-4.x', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^claude-opus-4-6/i,
    profile: {
      family: 'claude-opus-4.6', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^claude-sonnet-4-6/i,
    profile: {
      family: 'claude-sonnet-4.6', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // Claude Haiku 4.5 — 200K, 独立条目
  {
    pattern: /^claude-haiku-4/i,
    profile: {
      family: 'claude-haiku-4', maxContextWindow: 200_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // 未单列的 Claude 4 型号采用 200K 保守窗口，避免把 4.5 等旧型号误判为 1M。
  {
    pattern: /^claude-(sonnet-4|opus-4|4-)/i,
    profile: {
      family: 'claude-4', maxContextWindow: 200_000, recommendedMaxTokens: 8_192,
      tier: 'very-high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // Claude 3.5 / 3.x
  {
    pattern: /^claude-(3\.5|3-)/i,
    profile: {
      family: 'claude-3', maxContextWindow: 200_000, recommendedMaxTokens: 4_096,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // Claude catch-all
  {
    pattern: /^claude-/i,
    profile: {
      family: 'claude', maxContextWindow: 200_000, recommendedMaxTokens: 4_096,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // Google Gemini 2.5 系列：1M 上下文，支持结构化输出
  // ════════════════════════════════════════════════════════
  {
    pattern: /^gemini-2\.5-pro/i,
    profile: {
      family: 'gemini-2.5-pro', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-2\.5-flash-lite/i,
    profile: {
      family: 'gemini-2.5-flash-lite', maxContextWindow: 1_000_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-2\.5-flash/i,
    profile: {
      family: 'gemini-2.5-flash', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-2\.5-/i,
    profile: {
      family: 'gemini-2.5', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // Gemini 3.x：当前 Flash 系列为 1,048,576 输入 / 65,536 输出。
  {
    pattern: /^gemini-3\.7-flash/i,
    profile: {
      family: 'gemini-3.7-flash', maxContextWindow: 1_048_576, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3\.6-flash/i,
    profile: {
      family: 'gemini-3.6-flash', maxContextWindow: 1_048_576, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3\.5-flash-lite/i,
    profile: {
      family: 'gemini-3.5-flash-lite', maxContextWindow: 1_048_576, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3\.5-flash/i,
    profile: {
      family: 'gemini-3.5-flash', maxContextWindow: 1_048_576, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3\.1-flash-lite/i,
    profile: {
      family: 'gemini-3.1-flash-lite', maxContextWindow: 1_048_576, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3\.1-pro/i,
    profile: {
      family: 'gemini-3.1-pro', maxContextWindow: 1_048_576, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3\.1-flash/i,
    profile: {
      family: 'gemini-3.1-flash', maxContextWindow: 1_048_576, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^gemini-3-/i,
    profile: {
      family: 'gemini-3', maxContextWindow: 1_048_576, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },

  // Gemini catch-all
  {
    pattern: /^gemini-/i,
    profile: {
      family: 'gemini', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // xAI Grok 系列：Grok 4.3/4.20 为 1M；旧 4.x 别名已重定向到 4.3。
  // ════════════════════════════════════════════════════════
  {
    pattern: /^grok-build-0\.1-/i,
    profile: {
      family: 'grok-build-0.1', maxContextWindow: 256_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^grok-4\.3/i,
    profile: {
      family: 'grok-4.3', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^grok-4\.1-fast/i,
    profile: {
      family: 'grok-4.1-fast', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^grok-4\.1-/i,
    profile: {
      family: 'grok-4.1', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^grok-4\.20-/i,
    profile: {
      family: 'grok-4.20', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^grok-4-/i,
    profile: {
      family: 'grok-4', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^grok-/i,
    profile: {
      family: 'grok', maxContextWindow: 131_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // Meta Llama 4 系列
  // Llama 4 Scout: 10M 上下文 (行业最大)
  // Llama 4 Maverick: 1M 上下文
  // ════════════════════════════════════════════════════════
  {
    pattern: /^llama-4-scout/i,
    profile: {
      family: 'llama-4-scout', maxContextWindow: 10_000_000, recommendedMaxTokens: 4_096,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^llama-4-maverick/i,
    profile: {
      family: 'llama-4-maverick', maxContextWindow: 1_000_000, recommendedMaxTokens: 4_096,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^llama-4-/i,
    profile: {
      family: 'llama-4', maxContextWindow: 1_000_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^llama-/i,
    profile: {
      family: 'llama', maxContextWindow: 128_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // Mistral AI 当前通用模型：Large 3 / Medium 3.5 / Small 4 均为 256K。
  // ════════════════════════════════════════════════════════
  {
    pattern: /^ministral-(14b|8b|3b)-/i,
    profile: {
      family: 'ministral-3', maxContextWindow: 256_000, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^mistral-large/i,
    profile: {
      family: 'mistral-large', maxContextWindow: 256_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^mistral-medium/i,
    profile: {
      family: 'mistral-medium', maxContextWindow: 256_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^mistral-small/i,
    profile: {
      family: 'mistral-small', maxContextWindow: 256_000, recommendedMaxTokens: 8_192,
      tier: 'medium', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^mistral-/i,
    profile: {
      family: 'mistral', maxContextWindow: 128_000, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },

  // ════════════════════════════════════════════════════════
  // Qwen (通义千问) 系列
  // Qwen 3.8 / 3.7 主力系列为 1M 上下文，并支持结构化输出。
  // ════════════════════════════════════════════════════════
  {
    pattern: /^qwen3\.8-max/i,
    profile: {
      family: 'qwen3.8-max', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen3\.7-max/i,
    profile: {
      family: 'qwen3.7-max', maxContextWindow: 1_000_000, recommendedMaxTokens: 32_768,
      tier: 'very-high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen3\.7-plus/i,
    profile: {
      family: 'qwen3.7-plus', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen3\.7-flash/i,
    profile: {
      family: 'qwen3.7-flash', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen3\.6-(plus|flash)/i,
    profile: {
      family: 'qwen3.6', maxContextWindow: 1_000_000, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen3-coder-plus/i,
    profile: {
      family: 'qwen3-coder-plus', maxContextWindow: 1_000_000, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen3-coder-next/i,
    profile: {
      family: 'qwen3-coder-next', maxContextWindow: 262_144, recommendedMaxTokens: 16_384,
      tier: 'high', supportsStructuredOutput: true, supportsJsonMode: true,
    },
  },
  {
    pattern: /^qwen-?max/i,
    profile: {
      family: 'qwen-max', maxContextWindow: 131_072, recommendedMaxTokens: 8_192,
      tier: 'high', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^qwen-?plus/i,
    profile: {
      family: 'qwen-plus', maxContextWindow: 131_072, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^qwen-?turbo/i,
    profile: {
      family: 'qwen-turbo', maxContextWindow: 131_072, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
  {
    pattern: /^qwen-/i,
    profile: {
      family: 'qwen', maxContextWindow: 131_072, recommendedMaxTokens: 4_096,
      tier: 'medium', supportsStructuredOutput: false, supportsJsonMode: false,
    },
  },
]

// ─── 默认值（未知模型） ────────────────────────────────

const DEFAULT_PROFILE: ModelProfile = {
  family: 'unknown',
  maxContextWindow: 128_000,
  recommendedMaxTokens: 4_096,
  tier: 'medium',
  supportsStructuredOutput: false,
  supportsJsonMode: false,
}

// ─── 工具函数 ──────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 将厂商/聚合平台常见的模型写法归一为注册表可匹配的形式。
 *
 * 支持例如 `openai/gpt-5.6-sol`、`models/gemini-3.7-flash`、
 * `z-ai/glm-5.3:free`；末尾补 `-` 让精确模型 ID 与带快照后缀的 ID
 * 走同一套前缀规则，同时避免 `gpt-4.1` 误匹配 `gpt-4.10`。
 */
function normalizeModelId(model: string): string {
  const withoutQuery = model.trim().split(/[?#]/, 1)[0]
  const segments = withoutQuery.split('/').filter(Boolean)
  const lastSegment = segments[segments.length - 1] ?? ''
  const withoutProviderVariant = lastSegment.split(':', 1)[0]
  return `${withoutProviderVariant.toLowerCase()}-`
}

// ─── 层级 → 上下文预算上限 ──────────────────────────────
// 防止单个对话无限吞噬上下文，按模型层级设合理的上限。
const TIER_CONTEXT_CAP: Record<ModelTier, number> = {
  'very-high': 120_000,   // o1, GPT-5.4, Claude Opus 4.6, Qwen-Max
  high: 64_000,            // GPT-4o, GPT-4.1, DeepSeek V4, Claude Sonnet 4.6
  medium: 32_000,          // GPT-4o-mini, GPT-4-Turbo
  low: 16_000,             // GPT-3.5, Mistral Small
}

/** 每轮对话（一问一答）的粗略 token 消耗 */
const AVG_TOKENS_PER_TURN = 600

/**
 * 工具调用循环的安全上限（防失控）
 *
 * 循环何时结束由**模型自己决定**：模型调用 `say` 说话即视为最终回复、终止循环；
 * 只要它持续调用工具（读写文件、切换情绪等）而不 `say`，循环就会一直继续。
 * 本常量并非行为性的“建议轮数”，而仅是一道兜底护栏——防止个别模型陷入
 * 永不 `say` 的死循环，导致持续请求 API、烧钱并卡住桌宠。正常任务远达不到此值。
 */
export const MAX_TOOL_TURNS = 50

// ─── 公开 API ──────────────────────────────────────────

/**
 * 根据模型名获取对应的能力画像
 *
 * 遍历注册表进行前缀匹配，未匹配则返回保守的默认画像。
 * 匹配结果可通过日志观察，方便新模型接入时排查。
 */
export function getModelProfile(model: string): ModelProfile {
  const normalizedModel = normalizeModelId(model)
  for (const entry of MODEL_REGISTRY) {
    if (entry.pattern.test(normalizedModel)) {
      log.debug('模型 [%s] 匹配→%s (窗口=%d, 层级=%s)',
        model, entry.profile.family, entry.profile.maxContextWindow, entry.profile.tier)
      return { ...entry.profile }
    }
  }
  log.info('模型 [%s] 未在注册表中找到，使用默认配置', model)
  return { ...DEFAULT_PROFILE }
}

/**
 * 根据模型能力计算建议的上下文历史 token 上限
 *
 * 策略：总窗口减去输出预留（recommendedMaxTokens）和系统提示词开销（~2K），
 * 再按模型层级施加上限，保证不过度占用上下文窗口。
 */
export function getContextLimit(model: string): number {
  const profile = getModelProfile(model)
  const reserved = profile.recommendedMaxTokens + 2_000
  const budget = profile.maxContextWindow - reserved
  const cap = TIER_CONTEXT_CAP[profile.tier]
  const limit = clamp(Math.min(budget, cap), 4_000, 200_000)
  log.trace('getContextLimit(%s) = %d (窗口=%d, 输出=%d, 层级上限=%d)',
    model, limit, profile.maxContextWindow, profile.recommendedMaxTokens, cap)
  return limit
}

/**
 * 根据模型能力估算建议保留的对话轮数
 *
 * 根据上下文上限 ÷ 每轮消耗估算，本质为 prune() 中快速路径的一个参考值。
 * 实际的裁剪仍由 maxContextTokens（token 预算）驱动。
 */
export function getMaxRounds(model: string): number {
  const limit = getContextLimit(model)
  const rounds = clamp(Math.floor(limit / AVG_TOKENS_PER_TURN), 5, 100)
  log.trace('getMaxRounds(%s) = %d (limit=%d, avgT=%d)',
    model, rounds, limit, AVG_TOKENS_PER_TURN)
  return rounds
}
