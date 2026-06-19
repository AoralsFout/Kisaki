# 设计：Live2D 口型同步（TTS lip-sync）

- 日期：2026-06-19
- 状态：设计稿
- 相关代码：`src/tts/speak.ts`、`src/character/live2d/controller.ts`、`src/components/Live2DStage.vue`、`src/stores/chat.ts`
- 前置：Live2D 集成 + 角色管理器 Live2D 支持（均已完成）

## 1. 背景与问题

Live2D 集成时把口型同步列为待办（设计 §9）。现状：TTS（CosyVoice）经 Rust 合成，前端用 `HTMLAudioElement` + `MediaSource` 流式播放，**与 Live2D 模型无联动**——模型说话时嘴不动。

关键发现：easy-live2d 的 `sprite.playVoice({ voicePath })` **自带口型同步**——内部 `fetch(url) → AudioContext.decodeAudioData → RMS` 驱动模型 `LipSync` 组（`ParamMouthOpenY`），在 Cubism update 内正确应用（无"参数被动画覆盖"问题）。`decodeAudioData` 支持 mp3（我们 TTS 输出即 mp3）。

## 2. 目标与非目标

### 目标
- Live2D 角色 TTS 播报时，模型嘴部跟随语音开合（用 easy-live2d 内置 `playVoice` lip-sync）。
- 立绘角色播报**零回归**（保持现有流式 HTMLAudio）。
- TtsEngine 与 Live2D **解耦**（注入式 voicePlayer 钩子，不直接依赖 agent 上下文/Live2D）。
- 口型对所有 Live2D 角色**自动生效**，无需 per-角色开关（模型无口型参数时仅播放、不动嘴，无害）。

### 非目标
- 不为 Live2D 角色保留流式低延迟（口型需完整音频 → 批处理；用户已确认接受短暂合成等待）。
- 不做情绪化口型/音素级嘴型（仅振幅驱动 `ParamMouthOpenY`，easy-live2d 内置）。
- 不改 CosyVoice 合成后端（继续用 `cosyvoice_tts` 批处理命令）。

## 3. 决策记录（用户已确认）
- **路线**：用 easy-live2d 内置 `playVoice`（而非自写 Web Audio 振幅驱动）——口型质量高、无参数覆盖风险。
- **延迟权衡**：Live2D 角色改批处理（合成完整音频 → blob URL → playVoice），换取可靠口型；立绘保持流式。
- **解耦**：TtsEngine 用注入式 `voicePlayer` 钩子；Live2DStage 在模型 ready 时注册、卸载时注销。
- **自动生效**：所有 Live2D 角色自动口型，无配置开关。

## 4. 架构

```
chat.ts: speakTextStreaming(text, voice)   ← 调用方不变
  └ TtsEngine：是否已注册 voicePlayer？
       ├ 是（Live2D 活跃）→ cosyvoice_tts 批合成 → base64 mp3 → blob URL
       │                    → voicePlayer(blobUrl, signal)
       │                    → controller.speakVoice → sprite.playVoice
       │                       （fetch → decodeAudioData(mp3) → RMS → LipSync 组）
       └ 否（立绘）→ 现有流式 HTMLAudio 播放
  取消：AbortController.abort() + sprite.stopVoice()
```

### 文件改动
| 文件 | 改动 |
|---|---|
| `src/tts/speak.ts` | `TtsEngine` 加 `voicePlayer` 字段 + `setVoicePlayer(fn\|null)`；`speakTextStreaming`/`speakText` 在 voicePlayer 注册时走"批合成 → blob URL → voicePlayer"，否则现有路径；`cancel()` 同时中止 voicePlayer 播放。导出 `setVoicePlayer`。 |
| `src/character/live2d/controller.ts` | 加 `speakVoice(url, signal): Promise<void>`：`sprite.playVoice({voicePath:url})`；`signal` 中止 → `sprite.stopVoice()`。 |
| `src/components/Live2DStage.vue` | onReady：`setVoicePlayer(controller.speakVoice)`；onDispose：`setVoicePlayer(null)`。 |
| `src/tts/index.ts` | 导出 `setVoicePlayer`。 |

## 5. 详细设计

### 5.1 voicePlayer 钩子（TtsEngine）
```ts
type VoicePlayer = (audioUrl: string, signal: AbortSignal) => Promise<void>
setVoicePlayer(fn: VoicePlayer | null): void
```
- 播放路由：`speakTextStreaming`/`speakText` 开头判断 `this.voicePlayer`：
  - 已注册 → 调 `cosyvoice_tts`（批，返回 base64+format）→ `URL.createObjectURL(blob)` → `await this.voicePlayer(url, controller.signal)` → finally `revokeObjectURL`。
  - 未注册 → 现有逻辑（流式/批 HTMLAudio）。
- `cancel()`：`controller.abort()`（voicePlayer 内部监听 signal → stopVoice）。

### 5.2 controller.speakVoice
```ts
async function speakVoice(url: string, signal: AbortSignal): Promise<void> {
  if (!sprite) return
  signal.addEventListener('abort', () => { try { sprite?.stopVoice() } catch {} }, { once: true })
  await sprite.playVoice({ voicePath: url, immediate: true })
}
```
（resolve 时机以 spike 结论为准；若 playVoice 在加载即 resolve，则需额外等播放结束——见 spike。）

### 5.3 Live2DStage 注册
- 复用现有 onReady/onDispose（scene 回调）。onReady 里 `setVoicePlayer((url, sig) => controller.speakVoice(url, sig))`；onDispose 里 `setVoicePlayer(null)`。

## 6. Spike（实现前验证，最大未知数）
1. `sprite.playVoice({voicePath: mp3 的 blob URL})` 能否播放？
2. 嘴是否动（ParamMouthOpenY 被驱动）？
3. 返回 Promise 的 resolve 时机（播完 / 加载完）——决定 speakVoice 是否需额外等待。
4. `stopVoice()` 能否中止。
- 验证手段：临时在 Live2DStage 模型 ready 后用一个 mp3 blob 调 playVoice，看口型 + 控制台计时 resolve；或用现有 Hiyori（含 LipSync 组）。

## 7. 测试
- 单元（vitest）：TtsEngine 路由——mock `cosyvoice_tts` invoke + 一个假 voicePlayer，断言注册时走 voicePlayer 路径、未注册走原路径；cancel 触发 signal。
- 手动 E2E：Live2D 角色对话 → 听到语音 + 看到嘴动；打断（连发消息）→ 旧语音停、嘴停；立绘角色播报无回归。

## 8. 错误处理
| 场景 | 行为 |
|---|---|
| playVoice 失败/模型未就绪 | voicePlayer 回退到 HTMLAudio 播放（有声音、无口型）；记录告警 |
| 合成失败 | 静默（同现有 TTS 行为） |
| 模型无 LipSync 参数 | playVoice 正常播放，嘴不动（无害） |
| 播报中切换到立绘角色 | voicePlayer 注销，回到流式 |

## 9. 未解决 / 未来扩展
- 若 playVoice 的 mp3 lip-sync 振幅效果不佳，可改用 CosyVoice 的 WAV/PCM 输出（CosyVoice 支持）提升 RMS 精度。
- 流式 + 口型（分段合成边播边同步）——复杂度高，暂不做。
- 与全局鼠标跟随修复（任务 #14）独立。
