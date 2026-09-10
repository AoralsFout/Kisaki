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

describe('say stream decoding', () => {
  it('parses completed payloads and trims fields', () => {
    expect(parseSayArgs('{"voice":"  hello ","display":" hi "}')).toEqual({
      voice: 'hello',
      display: 'hi',
    })
    expect(parseSayArgs('not-json')).toEqual({})
  })

  it('decodes incomplete fields and common escapes', () => {
    expect(extractPartialSayArgs('{"voice":"hello","display":"line 1\\nline 2')).toEqual({
      voice: 'hello',
      display: 'line 1\nline 2',
    })
  })
})
