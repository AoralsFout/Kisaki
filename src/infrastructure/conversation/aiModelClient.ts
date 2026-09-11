/**
 * 模型客户端端口的真机适配器。
 *
 * 它是**唯一**还认识 `src/ai/client.ts` 的地方：配置读取与校验、
 * 以及 `chat()` 的回调式 API 都收在这里，回合编排器只看到 Promise。
 * 网络策略（超时、重试、传输层选择）留在 `ai.chat` 既有的一处，不在这里复制一份。
 */
import { chat, isConfigValid, loadConfig } from '../../ai/client'
import type { ConversationModelClient, ConversationModelConfiguration, ConversationModelRequest } from '../../application/conversation/conversationSession'
import type { RawModelTurn } from '../../application/conversation/modelTurnInterpreter'

export class AiModelClient implements ConversationModelClient {
  /** 守卫与遥测读它：配置齐备与否决定回合能否开始。 */
  configuration(): ConversationModelConfiguration {
    const config = loadConfig()
    return {
      ready: isConfigValid(config),
      model: config.model || '',
    }
  }

  /**
   * 一次模型调用。`chat()` 的三个终局回调（onTools / onDone / onError）
   * 恰好对应 RawModelTurn 的两个变体与一次失败，这里做一一映射。
   *
   * onChunk / onThinking / onToolCallDelta 是过程增量，直接透传给回合。
   */
  async call(request: ConversationModelRequest): Promise<RawModelTurn> {
    return await new Promise<RawModelTurn>((resolve, reject) => {
      void chat(
        [...request.messages],
        {
          onChunk: delta => request.onChunk(delta),
          onThinking: delta => request.onThinking(delta),
          onToolCallDelta: calls => request.onToolCallDelta(calls),
          onTools: (calls, text) => resolve({ type: 'tools', calls, text }),
          onDone: text => resolve({ type: 'done', text }),
          onError: error => reject(error),
        },
        request.signal,
        [...request.tools],
        undefined,
        { requestId: request.requestId, turn: request.turn },
      )
        // chat() 在 try 之前还要 await 一次解密读取；那一步失败时它不会走 onError。
        // 少了这一句，调用方会一直等到回合上限，而不是拿到一次明确的失败。
        .catch(reject)
    })
  }
}
