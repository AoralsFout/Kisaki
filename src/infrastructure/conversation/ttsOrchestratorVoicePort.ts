/**
 * 语音播放入口端口的适配器：把既有的 TtsPlaybackOrchestrator 包成可注入的入口。
 *
 * 语义原样保留 —— 语音是回复提交之后的独立副作用：
 * `play()` 不返回 Promise、不 await，因此回合完成与否与它无关。
 * 谁在什么时机订阅「助手消息已提交」事件由组合根决定（见 #20），这里不接线。
 *
 * TTS provider / sink 管道本身不动，只作为已完成的组件复用。
 */
import type { TtsPlaybackOrchestrator } from '../../application/tts/ttsPlaybackOrchestrator'
import type { ConversationVoicePort, ConversationVoiceRequest } from '../../application/conversation/conversationSession'

export class TtsOrchestratorVoicePort implements ConversationVoicePort {
  /** 编排器由组合根持有并注入；适配器不自己 import 模块级单例。 */
  constructor(private readonly orchestrator: Pick<TtsPlaybackOrchestrator, 'play' | 'cancel'>) {}

  play(request: ConversationVoiceRequest): void {
    // 有意不 await：调用方（回合）不等语音，也不需要它的失败。
    void this.orchestrator.play({
      requestId: request.requestId,
      text: request.text,
      voiceId: request.voiceId,
      voiceLanguage: request.voiceLanguage,
      deduplicate: request.deduplicate,
    })
  }

  cancel(reason: string, resetDedupe?: boolean): void {
    this.orchestrator.cancel(reason, resetDedupe ?? false)
  }
}
