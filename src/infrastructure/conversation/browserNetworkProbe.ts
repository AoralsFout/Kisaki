/**
 * 在线状态探测的浏览器适配器。
 *
 * 取代回合内对 `navigator.onLine` 的现场读取。每次现读属性，不缓存：
 * 与迁移前逐次读 `navigator.onLine` 的语义一致。
 *
 * 有意不复用 `src/utils/network.ts` 里那份 `isOnline` —— 那是给界面用的响应式副本，
 * 带 Vue 依赖与挂载期事件监听；回合只需要一次同步查询。
 */
import type { ConversationNetworkProbe } from '../../application/conversation/conversationSession'

export class BrowserNetworkProbe implements ConversationNetworkProbe {
  isOnline(): boolean {
    return navigator.onLine
  }
}
