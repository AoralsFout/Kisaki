/**
 * 角色人设来源端口的 Pinia 适配器。
 *
 * 回合内原先是三处 `useCharacterStore()` 现场读取（工具清单、`getLangs()`、
 * TTS 订阅回调），这里收敛成一次 `state()`。控制器可能在本轮初始化期间才挂载，
 * 所以每次调用都现取，不缓存快照。
 *
 * 它必然 import Pinia store，因此只能待在基础设施层：
 * `src/architecture.boundaries.test.ts` 递归禁止 `src/application/**` 认识 vue / pinia / stores。
 */
import type { CharacterCapabilities } from '../../application/character/characterRuntime'
import type { ConversationCharacterSource, ConversationCharacterState } from '../../application/conversation/conversationSession'
import { DEFAULT_VOICE_LANGUAGE } from '../../constants'
import { useCharacterStore } from '../../stores/character'
import { resolveDisplayLanguage } from '../../stores/language'

export class CharacterStoreSource implements ConversationCharacterSource {
  state(): ConversationCharacterState {
    const store = useCharacterStore()
    const data = store.data
    /** 能力快照由 Runtime 持有；角色尚未挂载时为 null，工具清单据此收敛。 */
    const capabilities: CharacterCapabilities | null = store.getRuntimeSnapshot().capabilities

    return {
      // 无角色时不记录身份，assistant 消息因此回退到「按当前角色显示」。
      identity: data ? { id: store.currentId, name: store.name } : null,
      persona: data?.name,
      voice: data?.voice ?? '',
      // 角色没写 voiceLanguage 时回退到默认合成语言，保证 TTS 入参永远是有效代码。
      voiceLanguage: data?.voiceLanguage || DEFAULT_VOICE_LANGUAGE,
      // 显示语言的优先级（用户设置 > 角色 textLanguage > 默认）由既有的这一处归一化决定。
      displayLanguage: resolveDisplayLanguage(data?.textLanguage),
      render: data?.render ?? 'illustration',
      data,
      capabilities,
    }
  }
}
