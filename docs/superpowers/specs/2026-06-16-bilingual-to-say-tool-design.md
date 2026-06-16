# 设计：用 `say` 工具取代双语输出格式

- 日期：2026-06-16
- 状态：已实现（待提交）——类型检查 / 单测 / 构建均通过；端到端待用户用真实模型验证
- 相关代码：`src/ai/context.ts`、`src/ai/client.ts`、`src/ai/types.ts`、`src/ai/modelCapabilities.ts`、`src/stores/chat.ts`、`src/agent/*`、`src/tts/*`

## 1. 背景与问题

角色（如初）有两套语言：

- **语音语言 `voiceLang`**：角色母语，喂给 CosyVoice TTS 合成语音（如 `ja-JP`）。
- **显示语言 `displayLang`**：展示给用户的文字（如 `zh-CN`）。

当前实现要求模型在**一条回复里同时产出两种语言**，有两条通道：

1. 文本标记：`【日本語】…` + `【译文】…`，用正则 `parseBilingualResponse` 解析。
2. JSON 结构化输出：`{"native_text":…, "display_text":…}`，用 `response_format` 约束。

并叠加了多重防范：每轮格式提醒（`buildTurnReminder`）、违规检测（`nativeText === displayText` 时 `markFormatViolation`）、再发一次 LLM 修复（`attemptFormatRepair`）。

**问题：模型仍频繁忽略双语格式。** 根因经代码核实有三点：

1. **`response_format` 与 `tools` 互斥**（`client.ts:149`，亦是 OpenAI 兼容 API 的硬限制）。于是在最该产出文本的**第 0 轮（带工具那轮）**，可靠的 JSON 强制是关闭的，只能退回脆弱的 `【】` 标记（`chat.ts:404`）。
2. **JSON 通道对绝大多数 provider 根本不可用**：`supportsJsonMode` 当前硬编码 `return false`（`modelCapabilities.ts:723`），`supportsStructuredOutput` 仅 OpenAI 系为 `true`。即 DeepSeek / Claude / Gemini / Grok / Qwen **永远走 `【】` 标记**。
3. **架构上"文本与工具"二选一**：`chat()` 检测到 `tool_calls` 时只触发 `onTools`、丢弃已累积的正文（`client.ts:284`）。

结论：把"说话"放进**工具调用**通道，可同时绕开三个坑——工具调用在所有这些 provider 上都可靠，且能与动作工具共存。

## 2. 目标与非目标

### 目标

- 用 `say(voice, display)` 工具承载角色台词，取代 `【】` / JSON 双语格式。
- 跨所有支持 function calling 的 provider 行为一致。
- 模型漏字段 / 不调 `say` 时，系统**确定性兜底翻译**，保证"永不破"。
- 显式删除旧的双语解析、JSON schema、格式违规/修复等历史包袱。

### 非目标

- **不**改成"母语作主文本 + 系统翻译"的反转路线（那是另一种取舍）。
- **不**引入流式气泡 / 流式 TTS（维持当前非流式气泡；流式只有反转路线才划算）。
- **不**改动 CosyVoice 后端（`src-tauri/src/tts.rs`）与 `tts/speak.ts` 的播放逻辑。

## 3. 决策记录（用户已确认）

- **译文产出方式：混合兜底**——模型自己产双语（保语气/灵活），系统仅在缺失时兜底。
- **说话通道：统一 `say` 工具（路线 C）**——而非"显示走正文 + 语音独立工具（路线 A）"。
- 三个小取舍均采纳：① 保留一条极简的每轮 `say` 提醒（近因效应）；② 兜底翻译用"保留语气"的提示词，可选更便宜的模型；③ 采纳 `client.ts` 小改动，使兜底不丢词。

## 4. 架构

### 4.1 组件边界

- **agent 层只管"世界动作"，永不认识 `say`。** `say` 是对话层（chat store）职责：它的渲染就是气泡 + TTS，与现有 `triggerTts`、`currentBubbleText` 同层。
- `say` 的**工具定义**由 chat store 拼进发给 LLM 的 tools 数组：`tools = [...agentService.getToolDefinitions(), SAY_TOOL_DEF]`。它不进 `registry`/`executor`。
- 每轮请求都携带 tools（因为"说话"本身即工具），不再只在第 0 轮带。

### 4.2 各文件改动

| 文件 | 改动 |
|---|---|
| `src/agent/tools/say.ts`（新） | 仅导出 `SAY_TOOL_DEF`（工具 schema）。参数：`voice`（string，必填，母语台词）、`display`（string，选填，译文）。 |
| `src/ai/translate.ts`（新） | `translateText(text, targetLang, opts?)`：基于 `quickChat`，低温、保留语气；可选传入角色人设以保灵活。替代 `attemptFormatRepair`。 |
| `src/stores/chat.ts` | 主改。循环里拆 `sayCall` / `actionCalls`；动作照旧 `agentService.execute`；`say` 就地处理（字段兜底→气泡→TTS→终止）。tools 每轮都带。删除 JSON/`【】`/修复相关分支。 |
| `src/ai/context.ts` | system prompt 语言段改为"`say` 工具说话"指令；`TOOL_INSTRUCTIONS` 列入 `say` 并强调；保留 `voiceLang`/`displayLang`（用于措辞与兜底判断）；删 `buildJsonLangInstruction`、`buildTurnReminder`（替换为极简 say 提醒）、`setStructuredOutput`/`isStructured`、违规标记三件套。 |
| `src/ai/client.ts` | 小改：`onTools` 携带累计 `content`——`onTools(calls, text?)`。`StreamCallbacks.onTools` 与 `chatOnce` 的 `ChatResult` 同步扩展。happy path 不依赖此项。 |
| `src/ai/types.ts` | 删 `BILINGUAL_OUTPUT_SCHEMA`、`BILINGUAL_JSON_MODE`（确认无他用）。`ResponseFormat` 类型保留（`quickChat` 仍可用）。 |
| `src/ai/modelCapabilities.ts` | 删/弃用 `getBilingualResponseFormat`、`supportsStructuredOutput`、`supportsJsonMode`（确认无他用后）。`getToolTurns`/`getContextLimit`/`getMaxRounds` 保留。 |
| `src/ai/index.ts` | 同步导出增删。 |

### 4.3 `say` 工具定义（示意）

```
name: say
description: 说出你的台词。这是你与用户对话的唯一方式——每次想说话都必须调用它。
parameters:
  voice:   string  (required) 你的母语台词，纯口语、可被语音合成；不含 emoji/颜文字/动作描述/特殊符号
  display: string             翻译成<显示语言>的版本；若母语与显示语言相同可省略
```

## 5. 数据流

```
每轮请求（始终带 tools，无 response_format）
        │
   ┌────┴───────────────────────────────┐
 tool_calls                          纯 content（模型没用 say = 兜底路径）
   │                                    │
 拆分 say / actions                  先试 extractTextToolCalls(动作)；
   │                                  否则 content 当 display：
 执行 actions（串行）→ 改立绘           langs 相同 → voice = content
   │                                   langs 不同 → voice = translate(content → 母语)
 有 say?                              → 渲染 display + TTS(voice) + 终止
   ├─ 有：取 voice / display
   │     字段兜底：
   │       display 缺 → translate(voice → 显示语言)
   │       voice   缺 → translate(display → 母语)
   │       langs 相同 → display = voice，不调翻译
   │     气泡显示 display ＋ TTS 读 voice
   │     上下文：记 tool_calls + 全部 results（say 回执 "ok"）→ 终止
   └─ 无 say（仅动作）：继续下一轮，让模型接着说
```

要点：

- **终止语义**：本轮出现 `say` 即视为最终回复，跳出工具循环；仅有动作工具则 `continue` 到下一轮（模型"先动作、再说话"）。
- **执行顺序**：先执行所有动作工具（立绘先变），再处理 `say` 渲染。
- **UI 与上下文分离**（沿用现状）：`messages.value` 存 `display`（聊天记录）；`chatContext` 存 assistant 的 tool_calls 消息及其 results。

## 6. 错误处理 / 边界情形

- **多次 `say`**：取第一个，其余忽略并 `log.warn`。
- **`voice`、`display` 全空**：视为空回复 → 现有兜底气泡（`app.bubble.done`）。
- **`langs` 相同**：prompt 告知模型只需 `voice`；`display = voice`，不触发翻译。
- **非原生 FC 模型**：调不了 `say` → 输出正文 → 走兜底翻译，降级但可用。
- **兜底正文的语言假设**：模型不调 `say` 而输出纯 content 时，其语言不可知。本设计**统一假设 content 为显示语言**，按 `translate(content → 母语)` 得到 TTS 文本（若 content 实为母语，母语→母语翻译近似幂等，可接受）。不做语言检测（非目标）。
- **轮数耗尽仍未 `say`**：现有 `getToolTurns` 上限兜住 → 兜底气泡。
- **上下文合法性**：assistant 的 tool_calls 消息内所有 id（含 `say`）都补 tool result，避免"有调用无回执"被某些 provider 拒绝。
- **取消**：沿用本次请求独享的 `myAbort`，逻辑不变。
- **TTS 去重**：沿用 `lastTtsText`；兜底翻译产生的 `voice` 同样参与去重。
- **会话恢复（关键）**：`loadMessages` 重放历史时，助手回合必须**重建为 `say` 工具调用**（assistant tool_calls + tool 回执），而非纯文本 `addAssistantMessage`。否则恢复出的历史呈现“助手只用纯文本、从不调工具”的范式，模型会模仿它而忘记调用 say/动作工具（切走再切回稳定复现）。为忠实重建（尤其双语的母语 voice），`ChatMessage` 增持久化字段 `voice`；旧会话缺失时回退用 display 文本。重建后的消息结构与实时 say 流程逐条一致，无新增合法性风险。
- **兜底路径上下文对称**：实时的两条兜底路径（纯正文分支、有动作但未调 say 分支）通过 `commitSyntheticSay(voice, display)` 把台词作为合成 say 调用写入上下文，而非 `addAssistantMessage`。使“真 say 分支 / 兜底分支 / 会话恢复重建”三者的助手回合范式完全一致，避免纯文本回合污染范式。唯一例外是非原生 FC 的文本工具调用中间态（残留文本，会 continue 到下一轮再出 say，且不入会话持久化），保持 `addAssistantMessage`。

## 7. 删除清单（净简化）

- `parseBilingualResponse`、`tryParseStructuredOutput` 及 4 个正则（`NATIVE_RE`/`DISPLAY_RE`/两个 FALLBACK）。
- `attemptFormatRepair`（由 `translateText` 取代）。
- `buildLangInstruction`、`buildJsonLangInstruction`、`buildTurnReminder`（后者换成极简 say 提醒）。
- `markFormatViolation`、`needsFullFormatReattach`、`resetFormatViolationMarker`。
- `setStructuredOutput`、`isStructured` 及 `rebuildSystemPrompt` 的 structured 分支。
- `BILINGUAL_OUTPUT_SCHEMA`、`BILINGUAL_JSON_MODE`。
- `chat.ts` 循环里整套 `canUseJson`/`rf`/`getBilingualResponseFormat` 调用、DeepSeek 空内容重试。

预期"删多于增"。

## 8. 测试

- `say` 参数解析 + 字段兜底（仅 voice / 仅 display / 都有 / langs 相同）——纯函数单测。
- tool_calls 拆分 `say` vs 动作。
- 终止语义：有 `say` 即结束；仅动作则继续。
- 兜底路径：纯 content → 走 `translateText`（mock `quickChat`）。
- 替换 `src/stores/__tests__/chat.test.ts` 中针对旧双语解析的用例。

## 9. 风险与权衡

- **模型用正文而非 `say` 说话**：靠强 system prompt + 极简每轮提醒降低概率；命中时兜底翻译覆盖，仅多一次调用（与今日"格式违规即修复"成本相当，但更可预测）。
- **兜底翻译风味**：用"保留语气"的提示词缓解；可配置更便宜的模型控制成本。
- **每轮带 tools**：可能诱发额外动作调用；由 `getToolTurns` 上限与 `say` 终止共同约束。
