# 产品化能力实施规格（插件批次）

> **状态更新**：以下 1~5 项已落地到代码（单实例 / 开机自启 / 全局快捷键 / 通知 /
> 自动更新的插件接线 + 「检查更新」按钮；见 `Cargo.toml`、`src-tauri/src/lib.rs`、
> `capabilities/default.json`、`SettingsGeneral.vue`、`SettingsAbout.vue`、`src/utils/notify.ts`）。
> 自动更新的密钥、端点和 tag 发布已经接通。2026-08-27 的发布加固进一步修复了
> macOS 清单缺失，并增加平台完整性测试；正式发布仍必须执行旧版到候选版的升级验收。
> 第 6 项（系统代码签名与公证）按发布计划留在最后阶段，仍依赖自备证书与账号。
>
> 每项都给出：依赖安装 → Rust 接线 → capabilities 权限 → 前端调用 → 设置 UI 集成点。
> 已完成的纯前端产品化能力（窗口位置记忆、首次运行引导、隐私政策页）不在此列。

---

## 0. 通用前置

1. 新增插件后需在 `src-tauri/capabilities/default.json` 的 `permissions` 中追加对应权限，
   否则前端调用会被 ACL 拦截。
2. 每个插件都要在 `src-tauri/src/lib.rs` 的 `tauri::Builder::default()` 链上追加
   `.plugin(...)`，并确保 `use` 顺序与现有 `tauri_plugin_opener` / `tauri_plugin_dialog` 一致。
3. 前端 npm 包安装到 `package.json` dependencies，Rust crate 通过 `cargo add` 落到 `Cargo.toml`。
4. 涉及新设置的，在 `src/components/settings/SettingsGeneral.vue` 或新增一个
   「系统」标签页承载；文案统一走 i18n（4 语言）。

---

## 1. 单实例保护（single-instance）

**问题**：双击启动会开出两个桌宠进程、两个托盘、同时写同一份 `sessions.json`。

```bash
npm add @tauri-apps/plugin-single-instance
cargo add tauri-plugin-single-instance
```

`src-tauri/src/lib.rs`：

```rust
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    // 第二次启动：唤回并聚焦已存在的主窗口
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}))
```

capabilities（如需前端感知二次启动参数）：

```json
"single-instance:default"
```

> 托盘「退出」逻辑已存在（`tray.rs`），单实例与其互补：退出是 `app.exit(0)`，
> 二次启动只做「唤回」，不会重复初始化数据目录。

---

## 2. 开机自启（autostart）

```bash
npm add @tauri-apps/plugin-autostart
cargo add tauri-plugin-autostart
```

`lib.rs`：

```rust
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    None,
))
```

capabilities：

```json
"autostart:allow-enable",
"autostart:allow-disable",
"autostart:allow-is-enabled"
```

前端（`SettingsGeneral.vue` 新增开关）：

```ts
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'

const autoStart = ref(false)
onMounted(async () => { autoStart.value = await isEnabled() })

async function toggleAutoStart() {
  if (autoStart.value) await enable() else await disable()
}
```

> macOS 的 LaunchAgent 会在用户登录后启动；Linux 走 XDG autostart 桌面文件。
> 建议同时加到托盘右键菜单「开机自启」勾选项。

---

## 3. 全局快捷键（global-shortcut）

**目标**：无边框桌宠在「穿透态」下用户无法点击，需要快捷键唤出/隐藏（如 `Alt+K`）。

```bash
npm add @tauri-apps/plugin-global-shortcut
cargo add tauri-plugin-global-shortcut
```

`lib.rs`（在 `setup` 内注册，回调里切主窗口显隐，复用 `tray::toggle_main_window`）：

```rust
.plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

```rust
// setup 内
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
let sh = app.global_shortcut();
let _ = sh.register(Shortcut::new(None, tauri_plugin_global_shortcut::Code::KeyK))
    .inspect_err(|e| eprintln!("快捷键注册失败: {e}"));
// on_shortcut 回调中：只在按下(Pressed)时调用 tray::toggle_main_window(app)
```

capabilities（若走前端 register）：

```json
"global-shortcut:allow-register",
"global-shortcut:allow-unregister",
"global-shortcut:allow-is-registered"
```

> 建议默认用 `Alt+K`（各平台冲突较少），并在设置页提供「快捷键」输入框，
> 允许用户修改并持久化（localStorage）。注册失败（被其它应用占用）需给出提示。

---

## 4. 桌面通知（notification）

**目标**：AI 定时提醒、命令执行完成等需要系统级通知出口（穿透态下气泡不可见）。

```bash
npm add @tauri-apps/plugin-notification
cargo add tauri-plugin-notification
```

`lib.rs`：

```rust
.plugin(tauri_plugin_notification::init())
```

capabilities：

```json
"notification:default"
```

前端（封装 `src/utils/notify.ts`）：

```ts
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

export async function notify(title: string, body: string) {
  let granted = await isPermissionGranted()
  if (!granted) granted = (await requestPermission()) === 'granted'
  if (!granted) return
  sendNotification({ title, body })
}
```

> macOS 首次会弹权限请求；Windows/Linux 无需额外权限。给「提醒/定时任务」工具
> （`项目规划.md` 中的 `set_reminder`）预留此出口。

---

## 5. 自动更新（updater）

**目标**：用户无需手动重下安装包即可升级。

> ✅ 已完成：插件依赖、`lib.rs` 接线、capabilities 权限、`SettingsAbout.vue` 的
> 「检查更新」按钮（含优雅降级）、`tauri.conf.json`（pubkey + endpoints +
> createUpdaterArtifacts）、以及 CI 自动化（`.github/workflows/build.yml` 注入签名私钥、
> 汇总各平台 `.sig` 生成 `latest.json` 并上传，脚本见 `scripts/build-update-manifest.mjs`）。
> 发布流水线已使用 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` 生成签名更新包。
> 正式版还需完成旧版升级验收，并保证离线保存密钥恢复副本；更新私钥一旦丢失，
> 已安装客户端将无法继续接收后续更新。

```bash
npm add @tauri-apps/plugin-updater
cargo add tauri-plugin-updater
```

`lib.rs`：

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

capabilities：

```json
"updater:allow-check",
"updater:allow-download",
"updater:allow-install",
"updater:allow-download-and-install"
```

`tauri.conf.json` 增加：

```json
"plugins": {
  "updater": {
    "pubkey": "<tauri signer 生成的公钥>",
    "endpoints": ["https://你的域名/updates/{{target}}/{{arch}}/{{current_version}}"]
  }
}
```

前端（`SettingsAbout.vue` 或托盘菜单加「检查更新」）：

```ts
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const update = await check()
if (update) {
  await update.downloadAndInstall()
  await relaunch()
}
```

**签名与发布**（一次性）：

```bash
tauri signer generate -w ~/.tauri/kisaki.key     # 生成密钥，公钥填 pubkey
tauri signer sign -g ~/.tauri/kisaki.key ...     # 对构建产物签名
```

> updater 端点返回一个 JSON 清单（含版本、平台、下载 URL、签名）。可与现有
> `.github/workflows/build.yml` 的 `v*` tag Release 流程合并：Release 上传产物后，
> 再生成/上传 update manifest。`{{current_version}}` 会被替换为客户端当前版本号。

---

## 6. 代码签名与公证（发布硬门槛）

### Windows

- 获取 **EV 代码签名证书**（或 Azure Trusted Signing）。
- `tauri.conf.json` 的 `bundle.windows` 配置签名工具，或在 CI 用 `signtool sign`
  对 `.exe`/`.msi` 签名。
- 未签名的典型后果：SmartScreen 红色「未知发布者」警告。

### macOS

- 获取 **Developer ID Application** 证书，`tauri.conf.json` 的 `bundle.macOS` 配置
  `signingIdentity`，并用 `notarytool` + `stapler` 完成公证，否则 Gatekeeper 直接拦截。
- 透明窗口若使用辅助功能/输入监听，需在 entitlements 中声明。

### CI 集成建议

- 在 `build.yml` 的 release job 后追加签名 + 公证步骤，密钥/证书经 GitHub Secrets 注入，
  避免本地私钥泄漏。签名产物再走 updater 清单发布。

---

## 7. 落地顺序与验收

| 优先级 | 能力 | 验收标准 |
|------|------|---------|
| P0 | 单实例 | 双击/二次启动只唤回原窗口，不产生第二个托盘 |
| P0 | 代码签名 + 公证 | 三平台安装包无「未知发布者」警告 |
| P0 | 自动更新 | 旧版本点「检查更新」能下载安装并重启到新版本 |
| P1 | 开机自启 | 设置里开关，重启系统后桌宠自动出现 |
| P1 | 全局快捷键 | 穿透态下按快捷键能唤出/隐藏 |
| P1 | 通知 | AI 提醒能弹系统通知，macOS 权限正常 |

> 说明：本批次中「单实例」「自动更新」同时构成发布硬门槛，建议优先；
> 「开机自启/快捷键/通知」是体验补全，可随下个版本一起放。
