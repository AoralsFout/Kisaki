import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    // 限制并行转换压力，避免多个依赖 ChatStore 的测试同时首次编译大模块而超时。
    maxWorkers: 4,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      // 明确匹配源码，Vitest 会把未被测试导入的文件也放进报告。
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: [
        // 测试本身不属于产品源码。
        'src/**/*.test.ts',
        // 声明文件不产生运行时代码。
        'src/**/*.d.ts',
        // Tauri WebView 启动入口依赖真实窗口环境，不属于 happy-dom 单元覆盖面。
        'src/main.ts',
      ],
      reporter: ['text', 'html', 'json-summary'],
    },
  },
})
