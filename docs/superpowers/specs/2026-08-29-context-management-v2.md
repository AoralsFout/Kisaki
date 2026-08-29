# Context Management v2

## Goals

- Keep model context stable across session switches and application restarts.
- Enforce the complete input budget before every model request.
- Preserve useful task facts without elevating untrusted tool output to system instructions.
- Keep persisted context compact and remove credentials or large payload copies.
- Make pruning visible to the user.

## Runtime context

`ChatContext` owns the OpenAI-compatible protocol transcript. Before every request it counts the system prompt, rolling memory, recent messages, tool-call arguments, tool results, the current turn reminder, and all tool definitions. It removes the oldest complete turns until both the token and round budgets fit. Removed turns become a bounded history record containing user/assistant text, tool names, and coarse completion status; raw tool output is never promoted into that record.

If a single active turn remains too large, old tool output keeps both its head and tail and completed tool arguments are compacted. If the request still cannot fit, the call fails locally with an explicit context-budget error instead of relying on a provider error.

The per-turn `say` reminder is merged into the leading system message in the request copy. No trailing system message is emitted.

## Persistence

Each session stores two projections:

1. UI history: user and assistant display messages. Thinking text is runtime-only.
2. Protocol snapshot: non-system model messages plus rolling memory. Tool arguments are recursively redacted, credential-like values are removed, and large content fields are replaced with length metadata.

The current character prompt and safety rules are never restored from the snapshot. They are rebuilt from the current character before importing protocol messages. Legacy sessions without a snapshot retain the existing `say` replay migration path.

Rapid session saves are coalesced within the same event-loop turn, while Rust continues to write the resulting JSON atomically.

## Observability

The history panel shows estimated context usage, the active budget, and how many older rounds were summarized. Details include tool-definition cost and the number of pruned protocol messages.

## Model changes

Saving API configuration broadcasts an application event. The main window rebuilds `ChatContext` with the new model profile, reapplies the current persona, imports the existing sanitized snapshot, and persists the updated session. Secondary windows never write their potentially stale session copy in response to this event.
