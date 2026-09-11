import type { AudioSource } from './ttsProvider'

export interface AudioSinkContext {
  signal: AbortSignal
  /** Fired once when the sink has actually started producing sound. */
  onFirstAudio?: () => void
}

/**
 * Plays an already synthesized audio source.
 * Sinks own device/container differences; providers and the playback owner never do.
 */
export interface AudioSink {
  readonly id: string
  /** Whether this sink can consume the given source. Sinks are tried in registration order. */
  canPlay(source: AudioSource): boolean
  play(source: AudioSource, context: AudioSinkContext): Promise<void>
}

/** Picks the first registered sink that declares support for the source. */
export function selectAudioSink(sinks: readonly AudioSink[], source: AudioSource): AudioSink {
  const sink = sinks.find(candidate => candidate.canPlay(source))
  if (!sink) throw new Error(`No TTS audio sink can play source: ${source.kind}`)
  return sink
}
