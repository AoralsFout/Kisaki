/**
 * 文案端口适配器，建在既有的 i18n 之上。
 *
 * key 与迁移前 `stores/chat.ts` 里的调用逐字相同：改名不改文案，
 * 否则用户可见的提示会跟着变。
 */
import { t } from '../../i18n'
import type { ConversationTexts } from '../../application/conversation/conversationSession'

export class I18nConversationTexts implements ConversationTexts {
  imageOnlyPrompt(): string {
    return t('chat.input.imageOnlyPrompt')
  }

  networkOff(): string {
    return t('app.bubble.networkOff')
  }

  apiNotConfigured(): string {
    return t('app.bubble.apiNotConfigured')
  }

  error(msg: string): string {
    return t('app.bubble.error', { msg })
  }

  done(): string {
    return t('app.bubble.done')
  }
}
