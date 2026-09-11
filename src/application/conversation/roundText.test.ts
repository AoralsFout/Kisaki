/**
 * say 内容兜底的纯函数契约。
 *
 * 这些函数原先长在 `stores/chat.ts` 的函数体外侧，随回合编排搬到了这里；
 * 断言随之搬到本文件，不再经 store 的再导出转一手。
 */
import { describe, expect, it } from 'vitest'
import {
  isTtsSafeVoice,
  normalizeTtsSafeVoice,
  repairJapaneseWordCommas,
  resolveContentFallback,
  resolveSayContent,
} from './roundText'

/** 翻译桩：把目标语言代码作为前缀返回，便于断言「是否/向哪种语言调用了翻译」 */
const fakeTranslate = async (text: string, target: string) => `[${target}]${text}`

describe('isTtsSafeVoice', () => {
  it('放行文字与数字表达式内的符号', () => {
    expect(isTtsSafeVoice('你好')).toBe(true)
    expect(isTtsSafeVoice('版本2.6,完成率50%')).toBe(true)
  })

  it('符号两侧没有数字时视为 URL 或文件路径，不放行', () => {
    expect(isTtsSafeVoice('https://example.com')).toBe(false)
    expect(isTtsSafeVoice('C:/Users/alice/file.txt')).toBe(false)
  })
})

describe('repairJapaneseWordCommas', () => {
  it('只在日语单词内去掉误插的逗号，保留分句逗号', () => {
    expect(repairJapaneseWordCommas('こ,れから', 'ja-JP')).toBe('これから')
    expect(repairJapaneseWordCommas('はい,わかりました', 'ja-JP')).toBe('はい,わかりました')
  })

  it('非日语不做任何修改', () => {
    expect(repairJapaneseWordCommas('こ,れから', 'zh-CN')).toBe('こ,れから')
  })
})

describe('resolveSayContent', () => {
  it('两者齐全：不调翻译', async () => {
    const r = await resolveSayContent({ voice: 'やあ', display: '嗨' }, 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: 'やあ', display: '嗨' })
  })

  it('缺 display：翻译 voice 补出', async () => {
    const r = await resolveSayContent({ voice: 'やあ' }, 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: 'やあ', display: '[zh-CN]やあ' })
  })

  it('缺 voice：翻译 display 补出', async () => {
    const r = await resolveSayContent({ display: '嗨' }, 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '[ja-JP]嗨', display: '嗨' })
  })

  it('voice 含数字和数字常用符号时本地保留，不调用翻译', async () => {
    let translateCalls = 0
    const translate = async () => {
      translateCalls++
      return '不应调用'
    }
    const r = await resolveSayContent(
      { voice: '版本2.6，完成率50%', display: '版本2.6，完成率50%' },
      'zh-CN',
      'zh-CN',
      translate,
    )
    expect(translateCalls).toBe(0)
    expect(r).toEqual({ voice: '版本2.6,完成率50%', display: '版本2.6，完成率50%' })
  })

  it('网址和文件路径不能伪装成数字表达式绕过 TTS 安全改写', () => {
    expect(normalizeTtsSafeVoice('https://example.com', 'zh-CN')).toBeNull()
    expect(normalizeTtsSafeVoice('C:/Users/alice/file.txt', 'zh-CN')).toBeNull()
    expect(normalizeTtsSafeVoice('版本2.6,完成率50%,时间12:30,日期2026/09/09', 'zh-CN'))
      .toBe('版本2.6,完成率50%,时间12:30,日期2026/09/09')
  })

  it('voice 含括号等其他符号时触发 TTS 安全改写', async () => {
    let ttsSafe: boolean | undefined
    const rewrite = async (_text: string, _target: string, opts?: { ttsSafe?: boolean }) => {
      ttsSafe = opts?.ttsSafe
      return '版本二点六,已经完成'
    }
    const r = await resolveSayContent(
      { voice: '版本2.6（测试），已经完成！', display: '版本 2.6（测试），已经完成！' },
      'zh-CN',
      'zh-CN',
      rewrite,
    )
    expect(ttsSafe).toBe(true)
    expect(r).toEqual({ voice: '版本二点六,已经完成', display: '版本 2.6（测试），已经完成！' })
  })

  it('已调用 say 且仅有日语句读问题时本地修复，不走翻译兜底', async () => {
    let translateCalls = 0
    const translate = async () => {
      translateCalls++
      return '不应调用'
    }
    const r = await resolveSayContent(
      {
        voice: 'こんにちは、私はあなたのデスクトップペットです、こ,れからよろしくお願いします。',
        display: '你好！我是你的桌面宠物，请多多关照哦。',
      },
      'ja-JP',
      'zh-CN',
      translate,
    )
    expect(translateCalls).toBe(0)
    expect(r).toEqual({
      voice: 'こんにちは,私はあなたのデスクトップペットです,これからよろしくお願いします',
      display: '你好！我是你的桌面宠物，请多多关照哦。',
    })
  })

  it('语言相同：互为兜底，不调翻译', async () => {
    const r = await resolveSayContent({ voice: '你好' }, 'zh-CN', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '你好', display: '你好' })
  })
})

describe('resolveContentFallback', () => {
  it('语言不同：正文当 display，翻译出 voice', async () => {
    const r = await resolveContentFallback('你好呀', 'ja-JP', fakeTranslate)
    expect(r).toEqual({ voice: '[ja-JP]你好呀', display: '你好呀' })
  })

  it('语言相同：仍通过 TTS 安全改写生成 voice', async () => {
    const r = await resolveContentFallback('你好', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '[zh-CN]你好', display: '你好' })
  })

  it('空正文返回空', async () => {
    const r = await resolveContentFallback('   ', 'ja-JP', fakeTranslate)
    expect(r).toEqual({ voice: '', display: '' })
  })
})
