import { describe, expect, it, vi } from 'vitest'
import { ChannelAudioStream } from './channelAudioStream'

function stream(
  open: (send: (chunk: { data: string; format: string; is_last: boolean }) => void) => Promise<void>,
  signal = new AbortController().signal,
) {
  const onSynthesisStart = vi.fn()
  const source = new ChannelAudioStream({
    format: 'mp3-chunks',
    mimeType: 'audio/mpeg',
    signal,
    onSynthesisStart,
    open,
  })
  return { source, onSynthesisStart }
}

describe('ChannelAudioStream', () => {
  it('decodes frames and ends on the terminal marker', async () => {
    const chunks: number[] = []
    let ended = false
    const { source, onSynthesisStart } = stream(async send => {
      send({ data: btoa('ab'), format: 'mp3', is_last: false })
      send({ data: btoa('cdef'), format: 'mp3', is_last: false })
      send({ data: '', format: 'mp3', is_last: true })
    })

    await source.pipe({
      onChunk: chunk => chunks.push(chunk.byteLength),
      onEnd: () => { ended = true },
      onError: error => { throw error },
    })

    expect(chunks).toEqual([2, 4])
    expect(ended).toBe(true)
    expect(onSynthesisStart).toHaveBeenCalledOnce()
  })

  it('reports producer failures through the observer instead of rejecting', async () => {
    const onError = vi.fn()
    const onEnd = vi.fn()
    const { source } = stream(async () => { throw new Error('backend down') })

    await expect(source.pipe({
      onChunk: () => {},
      onEnd,
      onError,
    })).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'backend down' }))
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('stops forwarding frames once cancelled', async () => {
    const chunks: number[] = []
    const onEnd = vi.fn()
    let cancelDuringOpen: (() => void) | null = null
    const { source } = stream(async send => {
      send({ data: btoa('ab'), format: 'mp3', is_last: false })
      cancelDuringOpen?.()
      send({ data: btoa('cd'), format: 'mp3', is_last: false })
      send({ data: '', format: 'mp3', is_last: true })
    })
    cancelDuringOpen = () => source.cancel()

    await source.pipe({ onChunk: chunk => chunks.push(chunk.byteLength), onEnd, onError: () => {} })

    expect(chunks).toEqual([2])
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('never opens a transport that is already cancelled', async () => {
    const open = vi.fn()
    const { source } = stream(open)
    source.cancel()

    await source.pipe({ onChunk: () => {}, onEnd: () => {}, onError: () => {} })

    expect(open).not.toHaveBeenCalled()
  })

  it('skips corrupt frames without failing the stream', async () => {
    const chunks: number[] = []
    const { source } = stream(async send => {
      send({ data: 'not-base64!!', format: 'mp3', is_last: false })
      send({ data: btoa('ok'), format: 'mp3', is_last: false })
      send({ data: '', format: 'mp3', is_last: true })
    })

    await source.pipe({
      onChunk: chunk => chunks.push(chunk.byteLength),
      onEnd: () => {},
      onError: error => { throw error },
    })

    expect(chunks).toEqual([2])
  })
})
