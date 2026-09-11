import { Channel, invoke } from '@tauri-apps/api/core'
import type { TtsChunkPayload } from './channelAudioStream'

/**
 * Opens a request-scoped Tauri channel for one streaming TTS request.
 * The channel replaces the former global `tts-audio-chunk` event, so concurrent
 * requests can no longer receive each other's frames.
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
