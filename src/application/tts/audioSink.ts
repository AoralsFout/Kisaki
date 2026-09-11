import type { AudioSource } from './ttsProvider'

export interface AudioSinkContext {
  signal: AbortSignal
  /** 播放器真正开始出声时触发一次。 */
  onFirstAudio?: () => void
}

/**
 * 播放已经合成好的音频源。
 * 设备与容器差异由播放器自己承担，provider 和播放调度方无需关心。
 */
export interface AudioSink {
  readonly id: string
  /** 该播放器能否消费给定音源。按注册顺序依次尝试各个播放器。 */
  canPlay(source: AudioSource): boolean
  play(source: AudioSource, context: AudioSinkContext): Promise<void>
}

/** 返回第一个声明支持该音源的播放器。 */
export function findAudioSink(sinks: readonly AudioSink[], source: AudioSource): AudioSink | null {
  return sinks.find(candidate => candidate.canPlay(source)) ?? null
}

/** 为该音源选定播放器；无可用播放器时直接报错，不做静默降级。 */
export function selectAudioSink(sinks: readonly AudioSink[], source: AudioSource): AudioSink {
  const sink = findAudioSink(sinks, source)
  if (!sink) throw new Error(`No TTS audio sink can play source: ${source.kind}`)
  return sink
}
