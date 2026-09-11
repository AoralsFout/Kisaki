/**
 * 组合根：显式安装所有跨模块服务与监听器。
 *
 * 各模块不再在加载时自行注册副作用；启动流程只调用一次 composeApplication()，
 * 因此「谁被安装、安装了几次」可以从这一处读出来。
 */
import { createLogger } from './utils/logger'

const log = createLogger('Composition')

let composed = false

/** 幂等：重复调用（热更新、多入口）不会叠加监听器。 */
export async function composeApplication(): Promise<void> {
  if (composed) return
  composed = true

  const [
    { initTools },
    { installLocalSettingsBridge },
    { installMotionPreferenceSync },
    { installTtsPlaybackTelemetry },
  ] = await Promise.all([
    import('./agent'),
    import('./infrastructure/settings/localSettingsStore'),
    import('./utils/motionPreference'),
    import('./tts/orchestrator'),
  ])

  initTools()
  installLocalSettingsBridge()
  installMotionPreferenceSync()
  installTtsPlaybackTelemetry()

  log.debug('composition.ready.debug', '应用组合完成')
}
