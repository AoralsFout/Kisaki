/**
 * 主窗口启动序列。
 *
 * 这里的顺序是需求的一部分，不能随手调整：
 *  - 窗口先恢复位置再显示，避免默认位置白窗闪现后瞬移；
 *  - 凭据先预热解密缓存，后续同步 loadConfig 才能拿到明文 Key；
 *  - 会话必须先于角色初始化，否则会先加载默认角色再切走，
 *    造成首帧闪动和一次多余的角色配置/图片加载。
 */
import { loadConfigSecure, isConfigValid } from './ai'
import { loadCosyVoiceConfigSecure } from './tts'
import { useChatStore } from './stores/chat'
import { useSessionStore } from './stores/session'
import { useCharacterStore, initCharacterDataDir } from './character'
import { initPassthrough } from './passthrough'
import { initWindowState } from './utils/windowState'
import { createLogger } from './utils/logger'

const log = createLogger('Startup')

/**
 * 恢复窗口、预热凭据、加载会话与角色。
 *
 * 角色身份来源的注入已上移到组合根（同属装配）；这里只负责按依赖顺序触发加载。
 */
export async function startMainWindow(): Promise<void> {
  await initWindowState('main', { showAfterRestore: true })
    .catch(() => { /* 浏览器预览环境无原生窗口 */ })
  await initPassthrough().catch(() => { /* 浏览器预览环境无原生窗口 */ })

  // 加载并解密 API Key（填充解密缓存，后续 sync loadConfig 直接取缓存）
  await Promise.allSettled([
    loadConfigSecure(),
    loadCosyVoiceConfigSecure(),
  ])

  // 初始化 data_dir 路径（供 imageUrl / loadCharacterJson 使用），
  // await 确保 data_dir 就绪后再加载角色，避免时序竞态。
  await initCharacterDataDir().catch(() => { /* 非 Tauri 环境降级 */ })

  const chat = useChatStore()
  const sessionStore = useSessionStore()
  const charStore = useCharacterStore()

  chat.init()
  // 先读取上次会话，再直接加载该会话绑定的角色。
  await sessionStore.init()
    .catch((e) => log.error("startup.session_init_failed", "会话初始化失败", e))
  await charStore.init(sessionStore.currentSession?.characterId)
    .catch((e) => log.error("startup.character_init_failed", "角色初始化失败", e))
}

/** API 配置是否已保存（仅代表字段完整，不代表连接测试通过）。 */
export async function isApiConfigured(): Promise<boolean> {
  try {
    return isConfigValid(await loadConfigSecure())
  } catch {
    return false
  }
}
