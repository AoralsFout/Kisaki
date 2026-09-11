import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "fs";

// @ts-expect-error process 是 Node.js 全局变量
const host = process.env.TAURI_DEV_HOST;

// 从 package.json 读取版本号，注入为编译时常量
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // 以下 Vite 选项专为 Tauri 开发定制，只在 `tauri dev` 或 `tauri build` 时生效
  //
  // 1. 避免 Vite 清屏把 Rust 编译错误盖掉
  clearScreen: false,
  // 2. Tauri 要求端口固定，被占用时直接失败而不是自动换端口
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. 让 Vite 忽略对 `src-tauri` 的监听
      ignored: ["**/src-tauri/**"],
    },
  },
});
