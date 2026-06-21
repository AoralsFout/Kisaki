/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** 应用版本号，编译时从 package.json 注入 */
declare const __APP_VERSION__: string;
