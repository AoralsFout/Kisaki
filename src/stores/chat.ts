/**
 * 对话状态管理（Pinia）
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chat, quickChat, isConfigValid, loadConfig, ChatContext, supportsStructuredOutput, supportsJsonMode, getBilingualResponseFormat } from '../ai'
import type { ToolCallData, ResponseFormat } from '../ai'
import { agentService } from '../agent/service'
import type { ToolCall } from '../agent'
import { speakTextStreaming, cancelSpeak } from '../tts'
import { useCharacterStore } from '../character'
import { createLogger } from '../utils/logger'
import { DEFAULT_VOICE_LANGUAGE } from '../constants'
import { resolveDisplayLanguage } from './language'

const log = createLogger('ChatStore')

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 思考/推理过程内容 */
  thinking?: string
  timestamp: number
}

/** 一次 chat() 调用的结果 */
type ChatResult =
  | { type: 'done'; text: string }
  | { type: 'tools'; calls: ToolCallData[] }

/** 双语回复的语言标签匹配模式（增强容错） */
const NATIVE_RE = /【([^】]+)】\s*([\s\S]*?)(?=\s*【译文】|$)/
const DISPLAY_RE = /【译文】\s*([\s\S]*?)$/

/** 备用匹配：宽松模式，处理可能使用 [] 或 () 或其它变体的情况 */
const FALLBACK_NATIVE_RE = /\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*([\s\S]*?)(?=\s*\[{1,2}\s*译文\s*\]{1,2}|$)/
const FALLBACK_DISPLAY_RE = /\[{1,2}\s*译文\s*\]{1,2}\s*([\s\S]*?)$/

/**
 * 解析 AI 回复中的双语内容
 * 格式：
 *   【日语】こんにちは
 *   【译文】你好
 *
 * 如果解析失败则整段文本同时用作显示和 TTS
 *
 * @internal 导出以支持单元测试
 */
export function parseBilingualResponse(text: string): { nativeText: string; displayText: string } {
  // 1. 标准格式【】匹配
  const nativeMatch = text.match(NATIVE_RE)
  const displayMatch = text.match(DISPLAY_RE)

  if (nativeMatch && displayMatch) {
    const nativeText = nativeMatch[2].trim()
    const displayText = displayMatch[1].trim()
    if (nativeText && displayText) {
      return { nativeText, displayText }
    }
  }

  // 2. 如果标准匹配到但内容为空，尝试用备用匹配（[] 等变体）
  const fallbackNative = text.match(FALLBACK_NATIVE_RE)
  const fallbackDisplay = text.match(FALLBACK_DISPLAY_RE)
  if (fallbackNative && fallbackDisplay) {
    const nativeText = fallbackNative[2].trim()
    const displayText = fallbackDisplay[1].trim()
    if (nativeText && displayText) {
      return { nativeText, displayText }
    }
  }

  // 3. 如果 NATIVE_RE 只匹配到【标签】但没有【译文】，检查是否已包含译文内容
  if (nativeMatch && !displayMatch) {
    const nativeText = nativeMatch[2].trim()
    const rest = text.slice(nativeMatch[0].length).trim()
    // 如果剩余内容看起来像是译文（以【译文】开头或者只是一段不同的文本）
    if (rest && rest !== nativeText) {
      return { nativeText, displayText: rest }
    }
  }

  // 4. 没有【译文】标签但可能是纯母语回复（语音=显示语言的情况）
  // 此时整段文本同时用于显示和播报
  return { nativeText: text, displayText: text }
}

/**
 * 尝试从 JSON 结构化输出中提取双语内容
 * 适用于支持 response_format 的 provider（如 GPT-4o-mini）
 * 格式：{"native_text": "...", "display_text": "..."}
 *
 * 如果解析失败返回 null，由调用方降级到 parseBilingualResponse
 */
export function tryParseStructuredOutput(text: string): { nativeText: string; displayText: string } | null {
  try {
    const parsed = JSON.parse(text.trim())
    if (parsed && typeof parsed === 'object') {
      const nativeText = parsed.native_text?.trim()
      const displayText = parsed.display_text?.trim()
      if (nativeText && displayText) {
        return { nativeText, displayText }
      }
    }
  } catch {
    // 解析失败，非 JSON 格式
  }
  return null
}

/**
 * 当格式解析失败时，尝试让 AI 自行修复回复的格式
 * 使用非流式调用 + 低温度，尽量减少延迟和成本
 * @param originalText 模型原始回复
 * @param voiceLang 角色语音语言（如 "ja-JP"）
 * @param displayLang 用户显示语言（如 "zh-CN"）
 * @param signal 可选取消信号
 * @returns 修复后的格式化文本，若修复失败则返回空字符串
 */
async function attemptFormatRepair(
  originalText: string,
  voiceLang: string,
  _displayLang: string,
  signal?: AbortSignal,
): Promise<string> {
  const langNames: Record<string, string> = {
    'zh-CN': '中文（简体）',
    'zh-TW': '中文（繁体）',
    'en-US': '英语',
    'ja-JP': '日语',
    'ko-KR': '韩语',
    'fr-FR': '法语',
    'de-DE': '德语',
    'es-ES': '西班牙语',
    'ru-RU': '俄语',
  }
  const voiceName = langNames[voiceLang] || voiceLang

  try {
    const fixed = await quickChat(
      [
        {
          role: 'system',
          content: `你是一个格式修正助手。用户的回复没有遵循要求的双语格式。

要求格式：
【${voiceName}】<角色母语内容>
【译文】<用户语言内容>

请将以下回复重新组织成上面的格式。只输出修正后的文本，不要任何额外说明。`,
        },
        { role: 'user', content: originalText },
      ],
      signal,
    )
    // 验证修正结果是否可解析
    const parsed = parseBilingualResponse(fixed)
    if (parsed.nativeText && parsed.displayText && parsed.nativeText !== parsed.displayText) {
      log.info('格式修复成功: %d 字符 → %d 字符', originalText.length, fixed.length)
      return fixed
    }
    // 修复结果同样不可用
    log.warn('格式修复结果仍无效，放弃重试')
    return ''
  } catch (err) {
    log.warn('格式修复请求失败: %s', (err as Error).message)
    return ''
  }
}

/** 包装 chat() 为 Promise 返回 */
function chatOnce(
  messages: ReturnType<ChatContext['getMessages']>,
  tools: any[],
  signal: AbortSignal,
  callbacks: { onThinking: (t: string) => void; onChunk: (t: string) => void },
  responseFormat?: ResponseFormat,
): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    chat(
      messages,
      {
        onChunk: callbacks.onChunk,
        onThinking: callbacks.onThinking,
        onTools: (calls) => {
          resolve({ type: 'tools', calls })
        },
        onDone: (text) => {
          resolve({ type: 'done', text })
        },
        onError: (err) => {
          reject(err)
        },
      },
      signal,
      tools,
      responseFormat,
    )
  })
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const isProcessing = ref(false)
  const currentBubbleText = ref('')
  const currentThinking = ref('')
  const isTyping = ref(false)
  const showBubble = ref(false)
  const showInput = ref(false)
  const configReady = ref(false)
  /** 当前是否正在执行工具（子状态） */
  const isUsingTools = ref(false)

  let chatContext = new ChatContext()
  let abortController: AbortController | null = null

  function init() {
    configReady.value = isConfigValid(loadConfig())
    log.info('ChatStore 初始化, 配置%s就绪', configReady.value ? '' : '未')
  }

  /** 发送消息给 AI（支持工具调用循环） */
  async function sendMessage(text: string) {
    if (isProcessing.value) return
    if (!text.trim()) return

    const userText = text.trim()
    isProcessing.value = true

    // 用户发送新消息时，取消正在播放的语音
    cancelSpeak()

    if (!navigator.onLine) {
      log.warn('网络不可用，无法发送消息')
      showBubbleText('网络似乎断开了，联网后重试吧~', false)
      isProcessing.value = false
      return
    }

    if (!isConfigValid(loadConfig())) {
      log.warn('API 未配置，无法发送消息')
      showBubbleText('请先配置 API~ → 设置 填写 API 信息', false)
      isProcessing.value = false
      return
    }

    log.info('用户消息: "%s"', userText.slice(0, 100))

    // 添加用户消息
    addMessage('user', userText)
    chatContext.addUserMessage(userText)

    // 准备气泡
    showBubble.value = true
    currentBubbleText.value = ""
    isTyping.value = false
    currentThinking.value = ''

    // 同步角色数据到 agent 上下文（替代 agent 直接 import Pinia）
    {
      const charStore = useCharacterStore()
      if (charStore.data) agentService.syncCharacterData(charStore.data)
    }

    // 收集工具定义
    const tools = agentService.getToolDefinitions()

    // 检测当前模型是否支持 JSON 格式输出（strict json_schema 或 json_object）
    const config = loadConfig()
    const strictOk = supportsStructuredOutput(config.model)
    const jsonOk = supportsJsonMode(config.model)
    const canUseJson = strictOk || jsonOk
    if (canUseJson) {
      const mode = strictOk ? 'json_schema(严格)' : 'json_object(宽松)'
      log.info('📐 [结构化输出] 模型=%s 模式=%s', config.model, mode)
      // 启用 JSON 格式的系统提示词（即使有工具定义，工具轮次后的文本回复仍然需要 JSON）
      chatContext.setStructuredOutput(true)
    } else {
      log.info('📐 [结构化输出] 模型不支持 (model=%s)', config.model)
    }

    abortController = new AbortController()
    let thinkSplitDone = false

    // 工具调用循环，最多 5 轮防止死循环
    const MAX_TOOL_TURNS = 5
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      // 结构化输出与 tools 互斥：只在无工具轮次启用
      const turnHasTools = turn === 0 && tools.length > 0
      const rf = !turnHasTools && canUseJson ? getBilingualResponseFormat(config.model) : undefined
      if (rf) {
        log.info('📐 第%d轮: 使用 response_format=%s', turn, rf.type)
      } else if (turnHasTools) {
        log.info('📐 第%d轮: tools 启用 → 跳过 response_format', turn)
      }
      try {
        let contentBuffer = ""  // 单轮缓冲区：累积完整内容后统一解析
        const result = await chatOnce(
          chatContext.getMessages(),
          turnHasTools ? tools : [],
          abortController.signal,
          {
            onChunk: (delta) => {
              // 缓冲内容，不直接更新气泡（等待结构化解析后以打字机形式显示）
              contentBuffer += delta
              // 仍从内容中提取 thinking（如 <think> 标签）用于实时显示
              if (!thinkSplitDone) {
                const full = contentBuffer
                const match = full.match(/^([\s\S]*?)<\/think>\s*([\s\S]*)$/)
                if (match) {
                  const think = match[1].replace(/^<think>\s*/, '')
                  if (think) currentThinking.value = think
                  thinkSplitDone = true
                  return
                }
                if (full.includes('<think>') && !full.includes('</think>')) {
                  currentThinking.value = full.replace(/^[\s\S]*?<think>\s*/, '')
                  return
                }
              }
            },
            onThinking: (t) => {
              currentThinking.value += t
            },
          },
          rf,
        )

        if (result.type === 'done') {
          const finalText = result.text

          // 兜底：检测 AI 文本中是否包含工具调用（不支持原生 FC 的模型会把调用写在文字里）
          const textCalls = agentService.extractTextToolCalls(finalText)
          if (textCalls.length > 0) {
            isUsingTools.value = true
            currentBubbleText.value = ""
            // 将 AI 回复（不含工具调用部分）加入上下文
            const cleanText = agentService.stripTextToolCalls(finalText)
            if (cleanText) {
              chatContext.addAssistantMessage(cleanText)
            }
            // 依次执行工具
            for (const tc of textCalls) {
              const result = await agentService.execute(tc)
              chatContext.addToolResult(tc.id, result.content)
            }
            isUsingTools.value = false
            continue // 继续请求 AI 生成最终回复
          }

          // 正常文本回复 — 解析双语内容
          if (finalText) {
            // 如果启用了 JSON 格式输出，优先尝试 JSON 解析
            let parsed: { nativeText: string; displayText: string } | null = null
            let parseMethod = '标记格式【】'
            if (canUseJson) {
              parsed = tryParseStructuredOutput(finalText)
              if (parsed) {
                parseMethod = 'JSON结构化输出'
                log.info('📐 解析成功: %s', parseMethod)
              } else {
                log.warn('📐 JSON解析失败，降级到标记格式解析 (文本前60字: %s)', finalText.slice(0, 60))
              }
            }
            // JSON 解析失败或未启用结构化 → 降级到标记格式解析
            if (!parsed) {
              parsed = parseBilingualResponse(finalText)
            }
            let { nativeText, displayText } = parsed

            // 格式恢复：当语言不同但解析结果相同时（AI 忘记双语格式），
            // 自动发起一次修复请求
            if (nativeText === displayText) {
              const charStore = useCharacterStore()
              const vLang = charStore.data?.voiceLanguage || DEFAULT_VOICE_LANGUAGE
              const dLang = resolveDisplayLanguage(charStore.data?.textLanguage)
              if (vLang !== dLang) {
                log.warn('双语格式未遵守，尝试修复 (语音=%s, 显示=%s)', vLang, dLang)
                const repaired = await attemptFormatRepair(finalText, vLang, dLang, abortController?.signal)
                if (repaired) {
                  // 修复结果也尝试 JSON 解析优先
                  const repairedParsed = tryParseStructuredOutput(repaired) ?? parseBilingualResponse(repaired)
                  nativeText = repairedParsed.nativeText
                  displayText = repairedParsed.displayText
                }
              }
            }

            chatContext.addAssistantMessage(displayText)
            addMessage('assistant', displayText, currentThinking.value)
            log.info('📐 AI 回复完成 [解析:%s] (显示:%d字, TTS:%d字)', parseMethod, displayText.length, nativeText.length)
            // TTS 播报使用角色母语文本
            triggerTts(nativeText)
            // 气泡输出：非流式，等待结构化解析成功后以打字机动画显示文本
            currentBubbleText.value = displayText
            isTyping.value = true
          }
          break
        }

        if (result.type === 'tools') {
          // 执行工具
          isUsingTools.value = true
          currentBubbleText.value = ""

          // 将 tool_calls 加入上下文
          chatContext.addAssistantToolCall(result.calls)

          // 按顺序执行工具（大部分工具串行执行更安全）
          for (const tc of result.calls) {
            const toolCall: ToolCall = {
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || '{}'),
            }
            const toolResult = await agentService.execute(toolCall)
            chatContext.addToolResult(tc.id, toolResult.content)
          }

          isUsingTools.value = false
          currentBubbleText.value = ""
          // 继续循环，用工具结果再请求 AI
          continue
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') break
        showBubbleText(`出错了: ${(err as Error).message}`, false)
        break
      }
    }

    // 循环结束后没有文本回复（如全屏工具调用耗尽轮数），展示兜底提示
    if (!currentBubbleText.value) {
        showBubbleText('我已经处理好了，还有什么需要帮忙的吗？', false)
    }

    isProcessing.value = false
    abortController = null
  }

  /** 触发角色 TTS 语音播报 */
  let lastTtsText = ''
  async function triggerTts(text: string) {
    // 去重：连续播报相同文本跳过
    if (text === lastTtsText) return
    lastTtsText = text

    try {
      const charStore = useCharacterStore()
      const voiceId = charStore.data?.voice
      if (!voiceId) return
      await speakTextStreaming(text, voiceId)
    } catch {
      // 静默失败
    }
  }

  function cancelResponse() {
    abortController?.abort()
    abortController = null
    isProcessing.value = false
    isUsingTools.value = false
    cancelSpeak()
    log.info('AI 回复已取消')
  }

  function addMessage(role: ChatMessage['role'], text: string, thinking?: string) {
    messages.value.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      text,
      thinking: thinking || undefined,
      timestamp: Date.now(),
    })
  }

  function clearMessages() {
    messages.value = []
    chatContext = new ChatContext()
    log.info('聊天记录已清空')
  }

  function resetContext() {
    chatContext = new ChatContext()
    log.debug('对话上下文已重置')
  }

  /** 更新角色 system prompt（含语言配置） */
  function setSystemPrompt(prompt: string, voiceLang?: string, displayLang?: string) {
    chatContext.setSystemPrompt(prompt, voiceLang, displayLang)
  }

  function showBubbleText(text: string, typing: boolean = true) {
    currentBubbleText.value = text
    isTyping.value = typing
    showBubble.value = true
  }

  function hideBubble() {
    currentBubbleText.value = ""
    isTyping.value = false
    showBubble.value = false
  }

  function toggleInput() { showInput.value = !showInput.value }
  function openInput() { showInput.value = true }
  function closeInput() { showInput.value = false }

  return {
    messages,
    isProcessing,
    currentBubbleText,
    currentThinking,
    isTyping,
    showBubble,
    showInput,
    configReady,
    isUsingTools,
    init,
    sendMessage,
    cancelResponse,
    addMessage,
    clearMessages,
    resetContext,
    setSystemPrompt,
    showBubbleText,
    hideBubble,
    toggleInput,
    openInput,
    closeInput,
  }
})
