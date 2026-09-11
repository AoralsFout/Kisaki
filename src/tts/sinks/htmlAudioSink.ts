import type { AudioSink, AudioSinkContext } from '../../application/tts/audioSink'
import type { AudioSource } from '../../application/tts/ttsProvider'

/** 通过 HTMLAudioElement 播放完整音频；signal 中止即停。 */
export function playBlobWithHtmlAudio(
  blob: Blob,
  signal: AbortSignal,
  onFirstAudio?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let url = ''
    let settled = false
    let audio: HTMLAudioElement | null = null
    const cleanup = () => {
      if (url) {
        URL.revokeObjectURL(url)
        url = ''
      }
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => {
      try {
        audio?.pause()
        if (audio) audio.src = ''
      } catch { /* ignore */ }
      finish()
    }

    try {
      url = URL.createObjectURL(blob)
      audio = new Audio(url)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    audio.onended = () => finish()
    audio.onerror = () => finish(new Error('音频播放失败'))

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    audio.play()
      .then(() => onFirstAudio?.())
      .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

/** Default sink: buffered audio through the platform HTMLAudioElement. */
export class HtmlAudioSink implements AudioSink {
  readonly id = 'html-audio'

  canPlay(source: AudioSource): boolean {
    return source.kind === 'buffered'
  }

  async play(source: AudioSource, context: AudioSinkContext): Promise<void> {
    if (source.kind !== 'buffered') throw new Error(`${this.id} requires a buffered audio source`)
    await playBlobWithHtmlAudio(source.blob, context.signal, context.onFirstAudio)
  }
}
