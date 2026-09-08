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
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/vite-env.d.ts',
        'src/main.ts',
        'src/**/*.vue',
      ],
    },
  },
})
