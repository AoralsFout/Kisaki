import { describe, expect, it } from 'vitest'
import { parseEventLine, readServerSentEvents } from './serverSentEvents'

function streamOf(...chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }).getReader()
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> {
  const events: string[] = []
  for await (const event of readServerSentEvents(reader)) events.push(event)
  return events
}

describe('readServerSentEvents', () => {
  it('reassembles events split across chunk boundaries', async () => {
    const events = await collect(streamOf('data: {"a":', '1}\n\ndata: {"a":2}\n\n'))
    expect(events).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('emits every event when one chunk carries several frames', async () => {
    const events = await collect(streamOf('data: one\ndata: two\ndata: three\n'))
    expect(events).toEqual(['one', 'two', 'three'])
  })

  it('ignores comments and non-data lines', async () => {
    const events = await collect(streamOf(': keep-alive\nevent: ping\ndata: real\n'))
    expect(events).toEqual(['real'])
  })

  it('emits a trailing payload that has no newline', async () => {
    const events = await collect(streamOf('data: first\ndata: last'))
    expect(events).toEqual(['first', 'last'])
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(streamOf())).toEqual([])
  })

  it('recognizes only data lines with a payload separator', () => {
    expect(parseEventLine('data: hello')).toBe('hello')
    expect(parseEventLine('  data: padded  ')).toBe('padded')
    expect(parseEventLine('data:')).toBeNull()
    expect(parseEventLine('event: message')).toBeNull()
    expect(parseEventLine('')).toBeNull()
  })
})
