/**
 * 翻译兜底
 *
 * 当模型未自行给出某个语言版本（say 缺字段，或干脆没调用 say 而直接输出正文）时，
 * 由系统确定性地补出译文，保证"双语永不破"。
 *
 * 基于 quickChat（非流式、低温），并要求保留原本语气；失败时回退原文，
 * 确保即便翻译不可用，显示/语音也不会变空。
 */
import { quickChat } from './client'
import { langName } from './langNames'
import { createLogger } from '../utils/logger'

const log = createLogger('Translate')

export interface TranslateOptions {
  /** 说话者人设，用于让译文更贴合角色语气（可选） */
  persona?: string
  /** 取消信号 */
  signal?: AbortSignal
}

/**
 * 把文本翻译为目标语言，保留语气。
 *
 * @param text       原文
 * @param targetLang 目标语言代码（如 "ja-JP"）
 * @returns 译文；若原文为空或翻译失败，回退为原文 trim 结果
 */
export async function translateText(
  text: string,
  targetLang: string,
  opts?: TranslateOptions,
): Promise<string> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return ''

  const targetName = langName(targetLang)
  const personaLine = opts?.persona ? `说话者的人设：${opts.persona}\n` : ''

  try {
    const out = await quickChat(
      [
        {
          role: 'system',
          content:
            `你是翻译助手。${personaLine}把用户消息翻译成${targetName}，` +
            `保留原本的语气、称呼与情感。只输出译文本身，不要任何解释、标注或引号。`,
        },
        { role: 'user', content: trimmed },
      ],
      opts?.signal,
    )
    const result = out.trim()
    if (!result) {
      log.warn('翻译返回空，回退原文')
      return trimmed
    }
    log.debug('翻译完成 → %s (%d→%d 字)', targetLang, trimmed.length, result.length)
    return result
  } catch (err) {
    log.warn('翻译失败，回退原文: %s', (err as Error).message)
    return trimmed
  }
}
