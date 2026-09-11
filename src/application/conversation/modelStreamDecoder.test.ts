import { describe, expect, it } from 'vitest'
import { extractPartialSayArgs, ModelStreamDecoder, parseSayArgs } from './modelStreamDecoder'

describe('ModelStreamDecoder', () => {
  it('handles a think opening tag split across chunks without leaking it to the UI', () => {
    const decoder = new ModelStreamDecoder()

    expect(decoder.pushContent('<thi').visibleText).toBe('')
    expect(decoder.pushContent('nk>reason').thinking).toBe('reason')
    expect(decoder.pushContent('</think> answer')).toEqual({
      thinking: 'reason',
      visibleText: 'answer',
      sawThink: true,
      thinkComplete: true,
    })
    expect(decoder.pushContent('!').visibleText).toBe('answer!')
  })

  it('passes ordinary streamed text through unchanged', () => {
    const decoder = new ModelStreamDecoder()
    expect(decoder.pushContent('hello').visibleText).toBe('hello')
    expect(decoder.pushContent(' world')).toMatchObject({
      visibleText: 'hello world',
      sawThink: false,
    })
  })

  it('merges a provider-native reasoning channel into the same snapshot', () => {
    const decoder = new ModelStreamDecoder()
    decoder.pushThinking('first')
    decoder.pushThinking(' second')
    expect(decoder.snapshot().thinking).toBe('first second')
  })
})

describe('parseSayArgs', () => {
  it('解析 voice 与 display，并裁剪两端空白', () => {
    expect(parseSayArgs('{"voice":"こんにちは","display":"你好"}')).toEqual({ voice: 'こんにちは', display: '你好' })
    expect(parseSayArgs('{"voice":"  あ  "}')).toEqual({ voice: 'あ', display: undefined })
  })

  it('缺失字段返回 undefined，非法 JSON 返回空对象', () => {
    expect(parseSayArgs('{"voice":"あ"}')).toEqual({ voice: 'あ', display: undefined })
    expect(parseSayArgs('not json')).toEqual({})
  })
})

describe('extractPartialSayArgs', () => {
  it('从未闭合的 JSON 参数中提取已到达的字段', () => {
    expect(extractPartialSayArgs('{"voice":"こんにちは","display":"你')).toEqual({
      voice: 'こんにちは',
      display: '你',
    })
  })

  it('解码常见的 JSON 转义', () => {
    expect(extractPartialSayArgs('{"display":"第一行\\n第二行\\"引号\\""}')).toEqual({
      voice: undefined,
      display: '第一行\n第二行"引号"',
    })
  })
})
