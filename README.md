# Kisaki

> 基于 Tauri + Vue 3 的桌面桌宠应用 — AI 对话、TTS 语音播报。

[![Tauri 2](https://img.shields.io/badge/Tauri-2-67D8F5?logo=tauri)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## ✨ 特性

- **AI 对话** — 接入 OpenAI 兼容 API，支持自定义模型和地址；视觉模型可识别粘贴或选择的图片
- **TTS 语音播报** — 阿里云 CosyVoice 实时语音合成
- **会话管理** — 多会话切换，历史消息持久化
- **角色管理** — 导入/导出角色包（`.zip`），自定义角色
- **工具调用** — AI 可主动切换角色、控制窗口
- **多语言** — AI 回复文本可翻译为指定语言显示
- **桌面体验** — 系统托盘、单实例、开机自启、全局快捷键（Alt+K）、桌面通知

## 🚀 快速开始

### 前置要求

- [Node.js 18+](https://nodejs.org)
- [Rust](https://www.rust-lang.org/tools/install)
- Windows / macOS / Linux

> **Linux 额外依赖**：需安装 Tauri 的 WebView 与系统托盘所需的系统库（Debian/Ubuntu）：
>
> ```bash
> sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
>   libayatana-appindicator3-dev libxdo-dev libssl-dev build-essential
> ```
>
> 鼠标穿透依赖全局光标坐标，在 **X11** 下可用；**Wayland** 因协议限制无法获取全局光标，穿透不可用（已知限制）。

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
| 生产 · Windows | `%APPDATA%\com.kisaki.app\characters`（即 `C:\Users\<用户>\AppData\Roaming\com.kisaki.app\characters`） |
| 生产 · macOS | `~/Library/Application Support/com.kisaki.app/characters` |
| 生产 · Linux | `$XDG_DATA_HOME/com.kisaki.app/characters`（默认 `~/.local/share/com.kisaki.app/characters`） |

> 生产环境首次启动时角色目录为空，桌宠会提示「还没有角色」。正式 Release 会附带一个 `characters.zip`（名单见 `characters/release-allowlist.json`，仅需填写角色 id），可从首次引导下载后在 **设置 → 角色** 导入；也可以新建自己的角色。应用内改动保存在用户数据目录，升级不会丢失。

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

### Live2D 角色

角色支持两种渲染方式，由 `character.json` 的 `render` 字段决定：

- `"illustration"`（默认）：静态立绘，按 `pose / emotion / costume` 标签切图。
- `"live2d"`：Live2D 动态模型（[easy-live2d](https://github.com/Panzer-Jack/easy-live2d) + pixi.js v8）。

Live2D 角色目录结构：

```
<角色id>/
  character.json        # render:"live2d" + live2d 配置块
  prompt.txt
  live2d/
    <模型名>/
      *.model3.json     # 模型入口（moc3 / 贴图 / 动作由它引用）
      ...
```

`character.json` 的 `live2d` 配置块：

| 字段 | 说明 |
|---|---|
| `model` | model3.json 相对角色目录的路径（必填） |
| `scale` / `offsetX` / `offsetY` | 显示缩放与偏移（可选） |
| `idleMotionGroup` | 空闲动作组（可选，缺省取首个组） |
| `tapMotionGroup` | 点击反应动作组（可选） |
| `mouseFollow` | 鼠标跟随（可选，默认 true） |
| `expressions` / `motions` | 表情/动作组的中文描述注解（可选，帮助 AI 理解） |

表情与动作会从 `.model3.json` 自动发现；AI 通过 `set_expression` / `play_motion` 工具控制。

> **Cubism Core**：Live2D 渲染依赖 `public/Live2dCore/live2dcubismcore.js`（Live2D 专有运行时，已随仓库提供，受 Live2D 专有许可约束）。
>
> **模型授权**：Live2D 官方免费示例模型多数**禁止再分发**，不要打进对外发布的角色包；正式分发不再强制校验授权材料，版权与许可责任由角色作者/提供方自行承担。开发用模型已在 `.gitignore` 中忽略。

## 🔧 配置

在设置面板中配置：

| 配置项 | 说明 |
|-------|------|
| API 地址 | OpenAI 兼容接口地址 |
| API Key | 你的 API Key（仅本地保存） |
| 模型 | 对话模型名称 |
| TTS API Key | 阿里云百炼 DashScope Key |
| 语音模型 / 音色 | CosyVoice 合成参数 |

使用支持 Vision / 多模态输入的模型时，可在对话框点击“选择图片”，或直接粘贴剪贴板中的图片。一次最多发送 4 张，支持 PNG、JPEG、WebP 和 GIF。

## 🏗️ 技术栈

| 层 | 技术 |
|---|------|
| 框架 | [Tauri 2](https://tauri.app) |
| 前端 | [Vue 3](https://vuejs.org) + TypeScript |
| 状态管理 | [Pinia](https://pinia.vuejs.org) |
| Live2D | [easy-live2d](https://github.com/Panzer-Jack/easy-live2d) + [pixi.js](https://pixijs.com) v8 |
| TTS | 阿里云 CosyVoice（WebSocket 流式） |
| AI | OpenAI 兼容 API |

## 📄 许可

[MIT](./LICENSE) © AoralsFout

- [隐私说明](./PRIVACY.md)
- [安全政策](./SECURITY.md)
- [第三方许可](./THIRD_PARTY_NOTICES.md)
- [更新记录](./CHANGELOG.md)
- [发布基线](./docs/release-readiness.md)
- [RC 验收矩阵](./docs/rc-test-matrix.md)
- [发布与回滚手册](./docs/release-runbook.md)

## 🔗 链接

- 官网：[kisaki.aoralsfout.top](https://kisaki.aoralsfout.top)
- GitHub：[github.com/AoralsFout/Kisaki](https://github.com/AoralsFout/Kisaki)
