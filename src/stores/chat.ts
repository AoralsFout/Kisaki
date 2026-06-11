/**
 * 对话状态管理（Pinia）
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chat, isConfigValid, loadConfig, ChatContext } from '../ai'
import type { ToolCallData } from '../ai'
import { agentService } from '../agent/service'
import type { ToolCall } from '../agent'
import { speakTextStreaming, cancelSpeak } from '../tts'
import { useCharacterStore } from '../character'
import { createLogger } from '../utils/logger'

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

/** 双语回复的语言标签匹配模式 */
const NATIVE_RE = /【([^】]+)】([\s\S]*?)(?=【译文】|$)/
const DISPLAY_RE = /【译文】([\s\S]*?)$/

/**
 * 解析 AI 回复中的双语内容
 * 格式：
 *   【日语】こんにちは
 *   【译文】你好
 *
 * 如果解析失败则整段文本同时用作显示和 TTS
 */
function parseBilingualResponse(text: string): { nativeText: string; displayText: string } {
  const nativeMatch = text.match(NATIVE_RE)
  const displayMatch = text.match(DISPLAY_RE)

  if (nativeMatch && displayMatch) {
    const nativeText = nativeMatch[2].trim()
    const displayText = displayMatch[1].trim()
    if (nativeText && displayText) {
      return { nativeText, displayText }
    }
  }

  // 没有【译文】标签但可能是纯母语回复（语音=显示语言的情况）
  // 此时整段文本同时用于显示和播报
  return { nativeText: text, displayText: text }
}

/** 包装 chat() 为 Promise 返回 */
function chatOnce(
  messages: ReturnType<ChatContext['getMessages']>,
  tools: any[],
  signal: AbortSignal,
  callbacks: { onThinking: (t: string) => void; onChunk: (t: string) => void },
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
      showBubbleText('请先配置 API~ 右键菜单 → 设置 填写 API 信息', false)
      isProcessing.value = false
      return
    }

    log.info('用户消息: "%s"', userText.slice(0, 100))

    // 添加用户消息
    addMessage('user', userText)
    chatContext.addUserMessage(userText)

    // 准备气泡
    showBubble.value = true
    currentBubbleText.value = ''
    currentThinking.value = ''
    isTyping.value = false

    // 同步角色数据到 agent 上下文（替代 agent 直接 import Pinia）
    {
      const charStore = useCharacterStore()
      if (charStore.data) agentService.syncCharacterData(charStore.data)
    }

    // 收集工具定义
    const tools = agentService.getToolDefinitions()

    abortController = new AbortController()
    let thinkSplitDone = false

    // 工具调用循环，最多 5 轮防止死循环
    const MAX_TOOL_TURNS = 5
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      try {
        const result = await chatOnce(
          chatContext.getMessages(),
          turn === 0 ? tools : [],  // 只在第一轮发工具定义
          abortController.signal,
          {
            onChunk: (delta) => {
              // 分离  标签（如果内容里有）
              if (!thinkSplitDone) {
                const full = (currentBubbleText.value + delta)
                const match = full.match(/^([\s\S]*?)<\/think>\s*([\s\S]*)$/)
                if (match) {
                  const think = match[1].replace(/^<think>\s*/, '')
                  if (think) currentThinking.value += think
                  currentBubbleText.value = match[2]
                  thinkSplitDone = true
                  return
                }
                if (full.includes('<think>') && !full.includes('</think>')) {
                  currentThinking.value = full.replace(/^[\s\S]*?<think>\s*/, '')
                  currentBubbleText.value = ''
                  return
                }
              }
              currentBubbleText.value += delta
            },
            onThinking: (t) => {
              currentThinking.value += t
            },
          },
        )

        if (result.type === 'done') {
          const finalText = result.text

          // 兜底：检测 AI 文本中是否包含工具调用（不支持原生 FC 的模型会把调用写在文字里）
          const textCalls = agentService.extractTextToolCalls(finalText)
          if (textCalls.length > 0) {
            isUsingTools.value = true
            currentBubbleText.value = ''
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
            const { nativeText, displayText } = parseBilingualResponse(finalText)

            chatContext.addAssistantMessage(displayText)
            addMessage('assistant', displayText, currentThinking.value)
            log.info('AI 回复完成 (%d 字符, TTS: %d 字符)', displayText.length, nativeText.length)
            // TTS 播报使用角色母语文本
            triggerTts(nativeText)
          }
          break
        }

        if (result.type === 'tools') {
          // 执行工具
          isUsingTools.value = true
          currentBubbleText.value = ''

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
          // 继续循环，用工具结果再请求 AI
          currentBubbleText.value = ''
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
    isTyping.value = false
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
    isTyping.value = false
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
    showBubble.value = false
    currentBubbleText.value = ''
    isTyping.value = false
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
