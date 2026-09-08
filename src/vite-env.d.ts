/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** Pixi 用于收紧 CSP 环境的副作用入口，上游未随包提供类型声明。 */
declare module "pixi.js/unsafe-eval";

/** 应用版本号，编译时从 package.json 注入 */
declare const __APP_VERSION__: string;
