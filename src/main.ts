import { createApp, type Component } from "vue";
import { createPinia } from "pinia";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./styles/tokens.css";
import "./styles/ui.css";
import "./utils/motionPreference";
import { createLogger, installGlobalErrorHandlers } from "./utils/logger";
import i18n from "./i18n";
import { QUERY_DEV, QUERY_LOGS, QUERY_SETTINGS } from "./constants";

// 正式模式禁用 WebView 默认右键菜单（透明无边框桌宠不应弹出浏览器菜单）。
// 开发模式保留默认菜单，让每个窗口都能从右键菜单检查当前页面。
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (e) => e.preventDefault())
}

const log = createLogger('Main')
installGlobalErrorHandlers(log)

/** 每个 Tauri WebView 只加载自己的根组件，避免辅助窗口执行主窗口的模块副作用。 */
async function loadRootComponent(): Promise<Component> {
  const params = new URLSearchParams(window.location.search)
  if (import.meta.env.DEV && params.has(QUERY_DEV)) {
    // Dev 面板可预览 Live2D；必须在导入相关组件前安装 Pixi 的 CSP-safe 实现。
    await import('pixi.js/unsafe-eval')
    return (await import('./components/settings/DevPanel.vue')).default
  }
  if (params.has(QUERY_SETTINGS)) {
    return (await import('./components/SettingsPanel.vue')).default
  }
  if (params.has(QUERY_LOGS)) {
    return (await import('./components/LogViewer.vue')).default
  }
  // 主窗口可渲染 Live2D；Pixi v8 需先切换到不使用 new Function() 的实现，
  // 否则会被 tauri.conf.json 中收紧的 CSP 拒绝。
  await import('pixi.js/unsafe-eval')
  return (await import('./App.vue')).default
}

async function bootstrap() {
  const RootComponent = await loadRootComponent()
  const app = createApp(RootComponent)
  app.use(createPinia())
  app.use(i18n)
  app.config.errorHandler = (error, _instance, info) => {
    void log.fatal("vue.unhandled_error", "Vue 组件未处理异常", error, { info })
  }
  app.mount("#app")
  log.info("main.module.info", "窗口应用已启动")
}

void bootstrap().catch(error => {
  void log.fatal("main.bootstrap.error", "窗口应用启动失败", error)
})
