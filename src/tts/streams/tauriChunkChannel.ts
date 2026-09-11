import { Channel, invoke } from '@tauri-apps/api/core'
import type { TtsChunkPayload } from './channelAudioStream'

/**
 * 为单次流式 TTS 请求打开请求作用域的 Tauri channel。
 * 该 channel 取代了原先全局的 `tts-audio-chunk` 事件，
 * 并发请求之间不会再互相收到对方的音频帧。
 */
export function openTauriChunkStream(
  command: string,
  args: Record<string, unknown>,
): (send: (chunk: TtsChunkPayload) => void) => Promise<void> {
  return send => {
    const channel = new Channel<TtsChunkPayload>()
    channel.onmessage = send
    return invoke(command, { ...args, onChunk: channel })
  }
}
