/**
 * 翻译端口的适配器，建在既有的 `translateText` 之上。
 *
 * 迁移前回合循环里有两处逐字相同的内联翻译闭包（`final-text` 兜底路径与 `say` 提交路径）；
 * 端口把「构造闭包」这件事收进适配器，回合只调用一次 `translate()`。
 *
 * 契约要求失败回退原文、不向回合抛错。`translateText` 本身已是这个语义（空输入、
 * 空译文、异常都回退原文），这里再兜一层，使底层换成别的实现时也不会漏异常进回合。
 */
import { translateText } from '../../ai/translate'
import type {
  ConversationTranslateContext,
  ConversationTranslator,
} from '../../application/conversation/conversationSession'

/** 底层翻译函数；缺省即既有的 `translateText`，注入值供测试使用。 */
export type TranslateTextFn = typeof translateText

export class AiConversationTranslator implements ConversationTranslator {
  // 形参不叫 translateText：与 import 同名会被 TS 的参数属性改写遮蔽掉，运行时取不到绑定的默认值。
  constructor(private readonly translateFn: TranslateTextFn = translateText) {}

  async translate(
    text: string,
    targetLang: string,
    context: ConversationTranslateContext,
  ): Promise<string> {
    try {
      return await this.translateFn(text, targetLang, {
        persona: context.persona,
        signal: context.signal,
        ttsSafe: context.ttsSafe,
        requestId: context.requestId,
        turn: context.turn,
      })
    } catch {
      // 端口契约：翻译失败回退原文，绝不把异常交给回合。
      return (text ?? '').trim()
    }
  }
}
