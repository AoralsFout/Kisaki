# Spec #28 验证记录

## 执行命令

干净安装与验证命令：

```powershell
npm ci
npm test
npm run build
npm run test:coverage
```

本次 worktree 在 Windows 中将 npm 缓存临时重定向到 `E:\Kisaki\exp\npm-cache`，避免访问用户目录；这不是仓库命令的前置要求。

覆盖率报告生成在 `coverage/`：HTML 入口为 `coverage/index.html`，机器可读摘要为 `coverage/coverage-summary.json`。该目录已加入 `.gitignore`。

## 旧口径

调整前的配置使用 V8 provider，覆盖范围仅为 `src/**/*.ts`，并排除所有 `.vue`；仓库没有直接声明 `@vitest/coverage-v8`，也没有专用覆盖率命令。按旧配置运行 `npm run test -- --coverage` 得到 157 个文件，包含 156 个运行时 `.ts` 与一个生成的 `.d.ts`，不含 Vue 文件。

旧口径基线：Statements 74.61%（4,958/6,645），Branches 66.61%（2,734/4,104），Functions 75.69%（1,093/1,444），Lines 77.41%（4,493/5,804）。

## 新口径与基线

`npm run test:coverage` 使用与 Vitest 4.1.8 匹配的 V8 provider，显式纳入 `src/**/*.ts` 和 `src/**/*.vue`。排除项逐项限定：`src/**/*.test.ts` 是测试代码，`src/**/*.d.ts` 是不产生运行时代码的声明文件，`src/main.ts` 是依赖真实 Tauri WebView 启动环境的入口。没有整类排除 Vue 文件。报告列出 199 个源文件：156 个 `.ts` 和全部 43 个 `.vue`。

新口径基线：Statements 64.34%（6,146/9,552），Branches 56.44%（3,562/6,311），Functions 62.34%（1,356/2,175），Lines 66.73%（5,538/8,299）。新口径新增了 43 个 Vue 单文件组件，旧、新百分比的分母不同；下降反映统计范围扩大，不能直接解读为测试质量退步。

| 文件 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `src/App.vue`（主窗口） | 0% | 0% | 0% | 0% |
| `src/components/ChatHistory.vue`（历史面板） | 73.78% | 67.83% | 78.72% | 80.68% |
| `src/components/ConversationDock.vue`（输入区布局） | 92.72% | 68.18% | 100% | 100% |
| `src/components/conversationDockLayout.ts`（布局计算） | 100% | 100% | 100% | 100% |
| `src/components/InputBox.vue`（输入区） | 87.40% | 82.69% | 81.57% | 90.72% |
| `src/components/settings/SettingsTts.vue`（TTS 设置） | 67.46% | 60.52% | 45.45% | 69.02% |

本次运行逐一报告了 `src/` 下全部 43 个 `.vue` 文件；其中 18 个组件为 0% 覆盖。`App.vue` 没有测试导入，但仍以 0/255 statements 出现在报告中，证明未导入组件也会计入统计。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | 通过：121 个测试文件、831 个测试 |
| `npm run build` | 通过：类型检查与 Vite 生产构建完成 |
| `npm run test:coverage` | 通过：121 个测试文件、831 个测试；生成上述新口径报告 |
