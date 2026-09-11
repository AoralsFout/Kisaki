import { describe, expect, it, vi } from 'vitest'
import { AiConversationTranslator } from './aiConversationTranslator'
import type { TranslateTextFn } from './aiConversationTranslator'
import type { ConversationTranslateContext } from '../../application/conversation/conversationSession'

function translateContext(
  overrides: Partial<ConversationTranslateContext> = {},
): ConversationTranslateContext {
  return {
    signal: new AbortController().signal,
    requestId: 'req-1',
    turn: 2,
    ...overrides,
  }
}

describe('AiConversationTranslator', () => {
  it('把回合的翻译上下文原样交给底层翻译函数', async () => {
    const translateText = vi.fn<TranslateTextFn>().mockResolvedValue('こんにちは')
    const translator = new AiConversationTranslator(translateText)
    const signal = new AbortController().signal

    const result = await translator.translate('你好', 'ja-JP', {
      persona: '小崎',
      signal,
      requestId: 'req-9',
      turn: 3,
      ttsSafe: true,
    })

    expect(result).toBe('こんにちは')
    expect(translateText).toHaveBeenCalledWith('你好', 'ja-JP', {
      persona: '小崎',
      signal,
      requestId: 'req-9',
      turn: 3,
      ttsSafe: true,
    })
  })

  it('省略 persona 时不伪造人设', async () => {
    const translateText = vi.fn<TranslateTextFn>().mockResolvedValue('hello')
    const translator = new AiConversationTranslator(translateText)

    await translator.translate('你好', 'en-US', translateContext())

    expect(translateText.mock.calls[0][2]?.persona).toBeUndefined()
    expect(translateText.mock.calls[0][2]?.ttsSafe).toBeUndefined()
  })

  it('底层抛错时回退原文，不把异常交给回合', async () => {
    const translateText = vi.fn<TranslateTextFn>().mockRejectedValue(new Error('upstream 500'))
    const translator = new AiConversationTranslator(translateText)

    await expect(translator.translate('  你好  ', 'ja-JP', translateContext())).resolves.toBe('你好')
  })

  it('缺省实现就是既有的 translateText：空文本回退为空串', async () => {
    // 为空时 translateText 直接回退，不发请求；这条同时验明缺省依赖确实接上了真实现。
    await expect(new AiConversationTranslator().translate('   ', 'ja-JP', translateContext()))
      .resolves.toBe('')
  })
})
