/**
 * 对话状态管理（Pinia）
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chat, isConfigValid, loadConfig, ChatContext } from '../ai'
import type { ToolCallData } from '../ai'
import { getDefinitions, executeToolCall, getTool, initTools } from '../agent'
import type { ToolCall } from '../agent'

// 初始化注册工具
initTools()

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

/**
 * 从 AI 文本中提取工具调用（兜底方案）
 * 匹配模式: function_name({ "key": "value" })
 * 支持同一文本中包含多个工具调用
 */
const TEXT_TOOL_CALL_RE = /(\w+)\s*\(\s*(\{[^}]*\})\s*\)/g

function extractTextToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = []
  const re = new RegExp(TEXT_TOOL_CALL_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const name = match[1]
    const argsStr = match[2]
    if (!getTool(name)) continue
    try {
      calls.push({
        id: `text_${Date.now()}_${calls.length}`,
        name,
        arguments: JSON.parse(argsStr),
      })
    } catch { /* 跳过解析失败的 JSON */ }
  }
  return calls
}

/** 从文本中移除工具调用部分，保留纯文本回复 */
function stripTextToolCalls(text: string): string {
  return text.replace(TEXT_TOOL_CALL_RE, '').trim()
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
  }

  /** 发送消息给 AI（支持工具调用循环） */
  async function sendMessage(text: string) {
    if (isProcessing.value) return
    if (!text.trim()) return

    const userText = text.trim()
    isProcessing.value = true

    if (!isConfigValid(loadConfig())) {
      showBubbleText('请先配置 API~ 右键菜单 → 设置 填写 API 信息', false)
      isProcessing.value = false
      return
    }

    // 添加用户消息
    addMessage('user', userText)
    chatContext.addUserMessage(userText)

    // 准备气泡
    showBubble.value = true
    currentBubbleText.value = ''
    currentThinking.value = ''
    isTyping.value = false

    // 收集工具定义
    const tools = getDefinitions()

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
          const textCalls = extractTextToolCalls(finalText)
          if (textCalls.length > 0) {
            isUsingTools.value = true
            currentBubbleText.value = ''
            // 将 AI 回复（不含工具调用部分）加入上下文
            const cleanText = stripTextToolCalls(finalText)
            if (cleanText) {
              chatContext.addAssistantMessage(cleanText)
            }
            // 依次执行工具
            for (const tc of textCalls) {
              const result = await executeToolCall(tc)
              chatContext.addToolResult(tc.id, result.content)
            }
            isUsingTools.value = false
            continue // 继续请求 AI 生成最终回复
          }

          // 正常文本回复
          if (finalText) {
            chatContext.addAssistantMessage(finalText)
            addMessage('assistant', finalText, currentThinking.value)
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
            const toolResult = await executeToolCall(toolCall)
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

    isProcessing.value = false
    isTyping.value = false
    abortController = null
  }

  function cancelResponse() {
    abortController?.abort()
    abortController = null
    isProcessing.value = false
    isTyping.value = false
    isUsingTools.value = false
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
  }

  function resetContext() {
    chatContext = new ChatContext()
  }

  /** 更新角色 system prompt */
  function setSystemPrompt(prompt: string) {
    chatContext.setSystemPrompt(prompt)
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
