/**
 * say 内容的文本兜底。
 *
 * 这些是纯函数：只做字符串归一化与「缺哪个语言版本就补哪个」的判定，不发请求。
 * 它们原先长在 `stores/chat.ts` 的函数体外侧，随回合编排一起搬到这里，
 * 让回合模块不依赖任何 Pinia / Tauri 环境。
 */

/** 翻译函数签名：把翻译端口包装成纯函数，供内容兜底使用。 */
export type TranslateFn = (
  text: string,
  targetLang: string,
  opts?: { ttsSafe?: boolean },
) => Promise<string>

/** voice 允许 Unicode 文字、数字、普通空格、半角逗号和数字常用符号。 */
export function isTtsSafeVoice(text: string): boolean {
  if (!/^[\p{L}\p{M}\p{Nd} .,%:+\/\-]*$/u.test(text)) return false

  // 点号、百分号、冒号、斜杠和正负号仅用于数字表达式。
  // 若符号两侧都没有数字，则更可能是 URL、文件路径、代码或缩写，必须交给模型
  // 做语义改写，而不能直接送入 TTS。
  const chars = Array.from(text)
  const numericSymbols = new Set(['.', '%', ':', '+', '/', '-'])
  const isDigit = (value?: string) => Boolean(value && /^\p{Nd}$/u.test(value))
  return chars.every((char, index) => (
    !numericSymbols.has(char)
    || isDigit(chars[index - 1])
    || isDigit(chars[index + 1])
  ))
}

/**
 * 修复模型在日语单词内误插的半角逗号。
 *
 * 例如 `こ,れから` 应为 `これから`；而 `はい,わかりました` 仍保留分句逗号。
 * Intl.Segmenter 不可用时安全回退为不修改。
 */
export function repairJapaneseWordCommas(text: string, voiceLang: string): string {
  if (!/^ja(?:-|$)/i.test(voiceLang) || !text.includes(',')) return text
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: 'word' }) => {
      segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
    }
  }).Segmenter
  if (!Segmenter) return text

  const segmenter = new Segmenter('ja', { granularity: 'word' })
  return text.replace(
    /[\p{Script=Hiragana}\p{Script=Katakana}]+(?:,[\p{Script=Hiragana}\p{Script=Katakana}]+)+/gu,
    (run) => {
      const parts = run.split(',')
      const joined = parts.join('')
      const wordBoundaries = new Set<number>()
      let segmentedLength = 0
      for (const part of segmenter.segment(joined)) {
        segmentedLength += part.segment.length
        if (part.isWordLike && segmentedLength < joined.length) wordBoundaries.add(segmentedLength)
      }

      let result = parts[0]
      let sourceOffset = parts[0].length
      for (const next of parts.slice(1)) {
        // 逗号正好落在分词边界时是分句；落在词内时是模型误插。
        result += wordBoundaries.has(sourceOffset) ? `,${next}` : next
        sourceOffset += next.length
      }
      return result
    },
  )
}

/**
 * 对不需要语义理解的 voice 问题做本地、确定性修复。
 *
 * 只接受文字、数字、空白、半角逗号、常见中日句读符号和数字常用符号。
 * 网址、代码或其他特殊符号仍返回 null，交给翻译模型按语义改写。
 */
export function normalizeTtsSafeVoice(text: string, voiceLang: string): string | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return ''
  if (!/^[\p{L}\p{M}\p{Nd}\s,、，。！？；：.%:+\/\-]*$/u.test(trimmed)) return null

  let normalized = trimmed
    .replace(/[、，。！？；：]+/gu, ',')
    .replace(/\s+/gu, ' ')
    .replace(/\s*,\s*/gu, ',')
    .replace(/,+/gu, ',')
    .replace(/^,+|,+$/gu, '')
  normalized = repairJapaneseWordCommas(normalized, voiceLang)
  return normalized && isTtsSafeVoice(normalized) ? normalized : null
}

/**
 * say 内容字段级兜底：缺失的语言版本由系统翻译补出。
 * - voice 只有句读问题时本地修复；缺失或需要语义改写时才调用翻译兜底
 * - display 缺失且语言不同时，翻译 voice 补出
 */
export async function resolveSayContent(
  raw: { voice?: string; display?: string },
  voiceLang: string,
  displayLang: string,
  translate: TranslateFn,
): Promise<{ voice: string; display: string }> {
  let voice = raw.voice ?? ''
  let display = raw.display ?? ''
  const normalizedVoice = voice ? normalizeTtsSafeVoice(voice, voiceLang) : null
  if (normalizedVoice !== null) voice = normalizedVoice
  if (voiceLang === displayLang) {
    if (!display) display = voice
    if (!voice && display) voice = await translate(display, voiceLang, { ttsSafe: true })
    else if (voice && normalizedVoice === null) voice = await translate(voice, voiceLang, { ttsSafe: true })
    return { voice, display }
  }
  if (!display && voice) display = await translate(voice, displayLang)
  if (!voice && display) voice = await translate(display, voiceLang, { ttsSafe: true })
  else if (voice && normalizedVoice === null) voice = await translate(voice, voiceLang, { ttsSafe: true })
  return { voice, display }
}

/**
 * 模型未调用 say、直接输出正文时的兜底：
 * 正文当显示文本；无论语言是否相同，都生成一份 TTS 安全的母语台词。
 * 显示语言不参与判定 —— 正文本身就是显示文本，不需要再按语言选一遍。
 */
export async function resolveContentFallback(
  content: string,
  voiceLang: string,
  translate: TranslateFn,
): Promise<{ voice: string; display: string }> {
  const display = (content ?? '').trim()
  if (!display) return { voice: '', display: '' }
  const voice = await translate(display, voiceLang, { ttsSafe: true })
  return { voice, display }
}
