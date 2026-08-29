import { describe, expect, it } from 'vitest'
import { getContextLimit, getModelProfile } from '../modelCapabilities'

describe('模型能力注册表', () => {
  it.each([
    ['gpt-5.6', 'gpt-5.6-sol', 1_050_000],
    ['gpt-5.6-terra', 'gpt-5.6-terra', 1_050_000],
    ['gpt-5.4-mini', 'gpt-5.4-mini', 400_000],
    ['gpt-5.4-nano-2026-03-17', 'gpt-5.4-nano', 400_000],
    ['claude-opus-5', 'claude-opus-5', 1_000_000],
    ['gemini-3.7-flash', 'gemini-3.7-flash', 1_048_576],
    ['deepseek-v4-pro', 'deepseek-v4-pro', 1_000_000],
    ['mistral-small-latest', 'mistral-small', 256_000],
    ['qwen3.8-max', 'qwen3.8-max', 1_000_000],
  ])('匹配当前模型 %s', (model, family, maxContextWindow) => {
    const profile = getModelProfile(model)
    expect(profile.family).toBe(family)
    expect(profile.maxContextWindow).toBe(maxContextWindow)
  })

  it.each([
    ['glm-5.3', 'glm-5.3', 1_000_000, true],
    ['z-ai/glm-5.3-flash:free', 'glm-5.3-flash', 1_000_000, true],
    ['glm-5.2', 'glm-5.2', 1_000_000, true],
    ['glm-4.7-flashx', 'glm-4.7-flash', 200_000, true],
    ['glm-4.5', 'glm-4.5', 128_000, true],
  ])('注册 GLM 系列 %s', (model, family, maxContextWindow, jsonMode) => {
    const profile = getModelProfile(model)
    expect(profile).toMatchObject({ family, maxContextWindow, supportsJsonMode: jsonMode })
  })

  it.each([
    ['kimi-k3', 'kimi-k3', 1_048_576],
    ['moonshotai/kimi-k3[1m]', 'kimi-k3', 1_048_576],
    ['kimi-k2.7-code-highspeed', 'kimi-k2.7-code-highspeed', 262_144],
    ['kimi-k2.6', 'kimi-k2.x', 262_144],
    ['kimi-k2-0711-preview', 'kimi-k2-0711', 131_072],
    ['moonshot-v1-128k-vision-preview', 'moonshot-v1-128k', 131_072],
    ['moonshot-v1-32k', 'moonshot-v1-32k', 32_768],
    ['moonshot-v1-8k', 'moonshot-v1-8k', 8_192],
  ])('注册 Kimi/Moonshot 系列 %s', (model, family, maxContextWindow) => {
    const profile = getModelProfile(model)
    expect(profile).toMatchObject({
      family,
      maxContextWindow,
      supportsStructuredOutput: true,
      supportsJsonMode: true,
    })
  })

  it('支持厂商前缀、快照和查询参数，同时不误匹配相邻版本', () => {
    expect(getModelProfile('openai/gpt-5.6-sol-2026-08-01?region=us').family)
      .toBe('gpt-5.6-sol')
    expect(getModelProfile('models/gemini-3.7-flash').family)
      .toBe('gemini-3.7-flash')
    expect(getModelProfile('gpt-4.10').family).toBe('unknown')
  })

  it('按模型窗口和输出预留计算小窗口模型的上下文预算', () => {
    expect(getContextLimit('moonshot-v1-8k')).toBe(4_144)
    expect(getContextLimit('glm-5.3')).toBe(120_000)
  })

  it('未知模型使用独立的保守默认画像', () => {
    const first = getModelProfile('future-model')
    first.family = 'changed'
    expect(getModelProfile('future-model')).toEqual({
      family: 'unknown',
      maxContextWindow: 128_000,
      recommendedMaxTokens: 4_096,
      tier: 'medium',
      supportsStructuredOutput: false,
      supportsJsonMode: false,
    })
  })
})
