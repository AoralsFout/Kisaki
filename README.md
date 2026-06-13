# Kisaki

> 基于 Tauri + Vue 3 的桌面桌宠应用 — AI 对话、TTS 语音播报。

[![Tauri 2](https://img.shields.io/badge/Tauri-2-67D8F5?logo=tauri)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## ✨ 特性

- **AI 对话** — 接入 OpenAI 兼容 API，支持自定义模型和地址
- **TTS 语音播报** — 阿里云 CosyVoice 实时语音合成
- **会话管理** — 多会话切换，历史消息持久化
- **角色管理** — 导入/导出角色包（`.zip`），自定义角色
- **工具调用** — AI 可主动切换角色、控制窗口
- **多语言** — AI 回复文本可翻译为指定语言显示

## 🚀 快速开始

### 前置要求

- [Node.js 18+](https://nodejs.org)
- [Rust](https://www.rust-lang.org/tools/install)
- Windows / macOS / Linux

### 安装 & 运行

```bash
# 克隆仓库
git clone https://github.com/AoralsFout/Kisaki.git
cd Kisaki

# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建
npm run tauri build
```

### 角色与角色包

应用本身不内置角色，所有角色都存放在数据目录中：

| 环境 | 角色目录 |
|------|---------|
| 开发（`tauri dev`） | 项目根 `characters/`（随 git 追踪，方便开发调试） |
| 生产（已安装） | 用户数据目录，Windows 为 `%APPDATA%\Roaming\com.kisaki.app\characters` |

> 生产环境首次启动时角色目录为空，桌宠会提示「还没有角色」。点击「添加角色」进入 **设置 → 角色**，导入一个角色包或新建角色即可开始聊天。应用内的所有改动都保存在用户数据目录，升级或重装不会丢失。

**角色包**是 `.zip` 文件，可在 **设置 → 角色** 一键导入 / 导出，用于分发和备份。推荐结构：

```
<角色id>/
  character.json   # 角色定义（id、名称、姿势/情绪/服装、立绘索引、语音等）
  prompt.txt       # 系统提示词（人设）
  images/
    *.png          # 立绘图片
```

> 导入时以 `character.json` 中的 `id` 字段作为角色标识，兼容「直接打包文件夹内容」和「带 `<id>/` 顶层目录」两种压缩方式；同名角色会被跳过、不覆盖已有修改。

将预置角色打包为官方角色包随版本发布：

```bash
npm run pack:characters   # 输出 dist-packs/characters.zip
```

## 🔧 配置

在设置面板中配置：

| 配置项 | 说明 |
|-------|------|
| API 地址 | OpenAI 兼容接口地址 |
| API Key | 你的 API Key（仅本地保存） |
| 模型 | 对话模型名称 |
| TTS API Key | 阿里云百炼 DashScope Key |
| 语音模型 / 音色 | CosyVoice 合成参数 |

## 🏗️ 技术栈

| 层 | 技术 |
|---|------|
| 框架 | [Tauri 2](https://tauri.app) |
| 前端 | [Vue 3](https://vuejs.org) + TypeScript |
| 状态管理 | [Pinia](https://pinia.vuejs.org) |
| Live2D | [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) |
| TTS | 阿里云 CosyVoice（WebSocket 流式） |
| AI | OpenAI 兼容 API |

## 📄 许可

[MIT](./LICENSE) © AoralsFout

## 🔗 链接

- 官网：[kisaki.aoralsfout.top](https://kisaki.aoralsfout.top)
- GitHub：[github.com/AoralsFout/Kisaki](https://github.com/AoralsFout/Kisaki)
