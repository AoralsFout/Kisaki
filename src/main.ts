// 必须最先导入：pixi v8 默认用 new Function() 生成着色器/uniform 同步代码，
// 打包后受 CSP 限制（无 'unsafe-eval'）会抛错导致 Live2D 无法渲染。此副作用导入
// 让 pixi 改用非 eval 实现（self-install），从而保持 CSP 收紧。详见 tauri.conf.json CSP。
import "pixi.js/unsafe-eval";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "@fortawesome/fontawesome-free/css/all.min.css";
import { createLogger } from "./utils/logger";
import i18n from "./i18n";

// 禁用 WebView 默认右键菜单（透明无边框桌宠不应弹出浏览器菜单）。
// 用 JS 监听替代 index.html 里的内联 oncontextmenu，从而可去掉 CSP 的 'unsafe-inline'。
document.addEventListener('contextmenu', (e) => e.preventDefault())

const log = createLogger('Main')

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.mount("#app");

log.info('应用已启动')
