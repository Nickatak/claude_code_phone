# Observed SDK Events

The events that actually surface in our three usage scenarios, derived empirically from the spike runs:

| Scenario | File | Events |
|---|---|---|
| Flat (just a prompt → response) | [raw-output.jsonl](../raw-output.jsonl) | 13 |
| One tool call (Bash `ls ~`) | [raw-output-toolcall.jsonl](../raw-output-toolcall.jsonl) | 35 |
| Subagent + nested toolcall | [raw-output-subagent-toolcall.jsonl](../raw-output-subagent-toolcall.jsonl) | 63 |

These three cover the operative usage. Anything not in here is theoretically possible per the SDK contract but does not appear in our usage and can be deferred or ignored. This is the *practical* event taxonomy for the rewrite, not the *exhaustive* SDK union.

---

## Findings worth promoting before reading the catalogue

These came out of looking at the raw events together. They invalidate or refine assumptions in [DOMAIN_MODEL.md](DOMAIN_MODEL.md) and need to be reflected when we revise it.

**1. One `assistant` event is one *content block*, not one *turn*.** This is the big one. Multiple `assistant` events can share a `message.id` — they're all parts of the same model message, emitted incrementally as each content block (thinking / tool_use / text) finishes. The boundary between turns is the `message.id` change, **not** the count of assistant events. Our DOMAIN_MODEL.md currently says "one Turn = one `assistant` event"; that's wrong. The correct rule is "one Turn = one `message.id`," and a Turn is constructed from N `assistant` events that share that id.

**2. Content blocks come in three observed types**: `thinking` (extended-thinking, often encrypted/empty with a `signature` field), `tool_use` (the model invoking a tool), and `text` (the model's textual response). The proposed Turn shape `{ text, tool_calls[] }` doesn't accommodate `thinking`, and it loses the *ordering* of blocks within a turn (text→tool_use→text→tool_use is real and the order carries meaning).

**3. Subagent activity surfaces in the parent's stream, tagged by `parent_tool_use_id`.** The subagent's own assistant events, tool_use blocks, and tool_results all flow through the parent's iterator with `parent_tool_use_id` set to the Agent tool's `tool_use_id`. So we *can* see the subagent's internal work — we just need to choose whether to render it, summarize it, or hide it. The `system/task_*` events give us a higher-level lifecycle view if we don't want to trace the inner events.

**4. The `user` event has at least four distinct shapes** depending on context (subagent prompt forwarding, top-level tool_result, nested-subagent tool_result, subagent's final result back to parent). They're disambiguated by the combination of `parent_tool_use_id`, the presence/absence of `tool_use_id` in `content`, and the shape of `tool_use_result`.

---

## Event taxonomy

Each entry: type, scenarios it appears in, a representative payload from the data, and notes.

### `system` / `init`

**Scenarios:** all three (always the first event of every Query).

**Example:**
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/home/nick/tools/pocket_claude",
  "session_id": "0cd63677-...",
  "tools": ["Task", "Bash", "Read", "Edit", ...],
  "mcp_servers": [{"name": "claude.ai Google Drive", "status": "needs-auth"}],
  "model": "claude-opus-4-7[1m]",
  "permissionMode": "bypassPermissions",
  "slash_commands": [...],
  "apiKeySource": "none",
  "claude_code_version": "2.1.126",
  "output_style": "default",
  "agents": ["claude-code-guide", "Explore", "general-purpose", "Plan", "statusline-setup"],
  "skills": [...],
  "plugins": [],
  "memory_paths": {"auto": "/home/nick/.claude/projects/.../memory/"},
  "fast_mode_state": "off",
  "uuid": "...",
  "analytics_disabled": false
}
```

**Notes:**
- Reports the resolved environment for this Query. Useful for verifying CLAUDE.md / settings / tool list / model is what we expected.
- `apiKeySource: "none"` is interesting — even though we're authenticated via `~/.claude/.credentials.json`, this field reports "none." Probably distinguishes "API key env var" from "OAuth-via-credentials-file." Worth verifying.
- `agents` lists the available subagent types. `Task` in `tools` is the Agent tool.

### `system` / `status`

**Scenarios:** all three. Observed values: `requesting`. (The doc says `compacting | requesting | null` are also possible but we haven't seen the others in our runs.)

**Example:**
```json
{
  "type": "system",
  "subtype": "status",
  "status": "requesting",
  "uuid": "...",
  "session_id": "..."
}
```

**Notes:**
- Fires immediately before each model API call. Useful as a "Claude is thinking" signal at the UX layer.
- In the subagent scenario, fires once at the start *and* once after the subagent completes (before the parent's final response). The `requesting` event count ≈ number of distinct API requests the SDK is about to make.

### `rate_limit_event`

**Scenarios:** all three (always emitted once near the start, after `system/status`).

**Example:**
```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1777889400,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "isUsingOverage": false
  },
  "uuid": "...",
  "session_id": "..."
}
```

**Notes:**
- Reports current rate-limit posture for the account. Doesn't require action — informational.
- Could surface as a UX hint when `status` is anything other than `"allowed"`, or when `resetsAt` is approaching.

### `stream_event`

**Scenarios:** all three. The most numerous event type by far (5 in flat, 24 in toolcall, 47 in subagent).

**Wrapper shape:**
```json
{
  "type": "stream_event",
  "event": { /* see sub-event types below */ },
  "session_id": "...",
  "parent_tool_use_id": null | "toolu_...",
  "uuid": "...",
  "ttft_ms": 1717  // only on the first stream_event of each model call
}
```

The interesting taxonomy is *inside* `event`. See the "Stream sub-events" section below.

### `assistant`

**Scenarios:** all three. Count: 1 (flat), 3 (toolcall), 4 (subagent).

**Example (text-only block):**
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-7",
    "id": "msg_01SES7UgtMk7XuGWerzQ9kQN",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "Hello! I'm doing well..."}],
    "stop_reason": null,
    "usage": {...}
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

**Critical**: `message.content` carries **only the just-completed content block**, not all blocks accumulated for the message. Multiple `assistant` events with the same `message.id` represent one model message delivered incrementally, one block at a time. To assemble a full Turn, group `assistant` events by `message.id` and concatenate their `content` arrays in order.

**Content block types observed in `message.content[0]`:**

- **`text`** — model's textual output. Field: `text`.
- **`thinking`** — extended-thinking. Fields: `thinking` (often empty in our runs), `signature` (encrypted blob).
- **`tool_use`** — model invoking a tool. Fields: `id`, `name`, `input`, `caller` (`{"type": "direct"}` for the parent's calls; subagent calls observed identically).

**`parent_tool_use_id`:** `null` for events from the top-level model, set to the Agent tool's `tool_use_id` for events emitted by a subagent's internal model calls.

### `user`

**Scenarios:** toolcall (1), subagent (3). Not in flat.

This event has **at least four distinct shapes** depending on the context. All disambiguated by `parent_tool_use_id` and the structure of `message.content`.

**Shape 1: top-level tool_result (toolcall scenario, line 49)**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "toolu_01HonUf3o6...",
      "type": "tool_result",
      "content": "bill_n_chill\ncaretaker\n...",
      "is_error": false
    }]
  },
  "parent_tool_use_id": null,
  "tool_use_result": {
    "stdout": "bill_n_chill\ncaretaker\n...",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```
The synthetic user-role event the SDK injects after a top-level tool runs. The structured `tool_use_result` field has the raw stdout/stderr.

**Shape 2: subagent prompt forwarding (subagent scenario, line 89)**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{"type": "text", "text": "Run `ls ~` (list the contents...)"}]
  },
  "parent_tool_use_id": "toolu_01VupuDfvbZ...",  // Agent tool's id
  "session_id": "...",
  "uuid": "...",
  "timestamp": "..."
}
```
When the parent invokes the Agent tool, the prompt that's forwarded to the subagent is re-emitted as a synthetic user-role event tagged with `parent_tool_use_id` pointing at the Agent's `tool_use_id`. No `tool_use_result` field.

**Shape 3: nested tool_result inside a subagent (subagent scenario, line 99)**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "toolu_01WF82y1RuZ...",  // subagent's tool_use, not the Agent's
      "type": "tool_result",
      "content": "bill_n_chill\n...",
      "is_error": false
    }]
  },
  "parent_tool_use_id": "toolu_01VupuDfvbZ..."  // Agent tool's id
}
```
Same as shape 1 (tool_result for a tool call), but tagged with `parent_tool_use_id` because the tool ran *inside* the subagent's loop. No `tool_use_result` field at the top level (the SDK doesn't surface the structured form for nested results in our run).

**Shape 4: subagent's final result back to parent (subagent scenario, line 103)**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "toolu_01VupuDfvbZ...",  // the Agent tool itself
      "type": "tool_result",
      "content": [{"type": "text", "text": "Here's the full output of `ls ~`:\n\n```\n..."}]
    }]
  },
  "parent_tool_use_id": null,  // back at the top level
  "tool_use_result": {
    "status": "completed",
    "agentId": "a68e0bef6d10b9114",
    "agentType": "Explore",
    "content": [{"type": "text", "text": "..."}],
    "totalDurationMs": 2449,
    "totalTokens": 14458,
    "totalToolUseCount": 1,
    "usage": {...},
    "toolStats": {"readCount": 0, "searchCount": 0, "bashCount": 1, ...}
  }
}
```
The Agent tool's *final* tool_result back to the parent. `parent_tool_use_id: null` (top-level), but the inner `tool_use_id` points at the Agent. The structured `tool_use_result` carries rich subagent metadata (agentId, agentType, totalDurationMs, totalTokens, toolStats).

### `result` / `success`

**Scenarios:** all three (always the terminal event).

**Example (toolcall):**
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 4991,
  "duration_api_ms": 6044,
  "num_turns": 2,
  "result": "Here's what's in your home directory:\n\n- bill_n_chill\n...",
  "stop_reason": "end_turn",
  "session_id": "...",
  "total_cost_usd": 0.03079875,
  "usage": {...},
  "modelUsage": {
    "claude-haiku-4-5-20251001": {"inputTokens": 349, ...},
    "claude-opus-4-7[1m]": {"inputTokens": 7, "outputTokens": 177, ...}
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "..."
}
```

**Notes:**
- `num_turns` counts model turns, not content-block events. Flat = 1, toolcall = 2 (one with tool_use, one with final answer), subagent-toolcall = 2 (the subagent's turns are not counted at the parent level).
- `result` is the final user-visible response text — same as the last `assistant` event's text content.
- `modelUsage` per-model is interesting: Haiku appears even in scenarios where we didn't ask for it. This is the SDK using Haiku internally for some auxiliary work (probably summarization, classification, or the subagent itself in scenario 3). Our cost accounting needs to handle this multi-model breakdown.
- `permission_denials` is empty in all our runs (we use `bypassPermissions`).
- We have not observed `error_during_execution`, `error_max_turns`, or `error_max_budget_usd` subtypes — those are theoretical until we trigger them.

### `system` / `task_started`

**Scenarios:** subagent only (1 occurrence).

**Example:**
```json
{
  "type": "system",
  "subtype": "task_started",
  "task_id": "a68e0bef6d10b9114",
  "tool_use_id": "toolu_01VupuDfvbZ...",  // the Agent tool's id
  "description": "List home directory contents",
  "task_type": "local_agent",
  "prompt": "Run `ls ~` (list the contents...)",
  "uuid": "...",
  "session_id": "..."
}
```

**Notes:**
- Fires when the SDK launches a subagent (after the parent emits the Agent tool_use).
- `task_id` is the subagent's identity — used to correlate subsequent `task_progress` and `task_notification` events.
- `tool_use_id` points back to the Agent tool's `tool_use_id` in the parent — the link to the parent's tool call.

### `system` / `task_progress`

**Scenarios:** subagent only (1 occurrence in our run; potentially more for longer tasks).

**Example:**
```json
{
  "type": "system",
  "subtype": "task_progress",
  "task_id": "a68e0bef6d10b9114",
  "tool_use_id": "toolu_01VupuDfvbZ...",
  "description": "Running List contents of home directory",
  "usage": {"total_tokens": 13569, "tool_uses": 1, "duration_ms": 931},
  "last_tool_name": "Bash",
  "uuid": "...",
  "session_id": "..."
}
```

**Notes:**
- Periodic progress signal during subagent execution. Useful for UX — surfaces the subagent's last tool name and running totals.
- One occurrence in our short run; longer subagent tasks would emit more.

### `system` / `task_notification`

**Scenarios:** subagent only (1 occurrence — terminal for the subagent).

**Example:**
```json
{
  "type": "system",
  "subtype": "task_notification",
  "task_id": "a68e0bef6d10b9114",
  "tool_use_id": "toolu_01VupuDfvbZ...",
  "status": "completed",
  "output_file": "",
  "summary": "List home directory contents",
  "usage": {"total_tokens": 14472, "tool_uses": 1, "duration_ms": 2448},
  "uuid": "...",
  "session_id": "..."
}
```

**Notes:**
- Terminal event for the subagent's lifecycle. Reports `status: "completed"` and final usage.
- Fires *before* the corresponding `user` event with the Agent's tool_result (which is what the parent sees).

---

## Stream sub-events (inside `stream_event.event`)

Six observed sub-event types, all from the `BetaRawMessageStreamEvent` taxonomy in `@anthropic-ai/sdk`.

### `message_start`

Begins an assistant message. Carries the message envelope (id, model, role, empty content, initial usage). Emits exactly once per model API call (= once per Turn).

### `content_block_start`

Begins a content block within a message. Carries the block's `index` and starting `content_block` (with `type` already set: `text`, `thinking`, or `tool_use`).

### `content_block_delta`

Incremental update to an in-progress content block. Carries the block's `index` and a `delta`. **The shape of `delta` depends on the block type:**

- **`text_delta`** — for `text` blocks. Field: `text` (a string fragment).
- **`signature_delta`** — for `thinking` blocks. Field: `signature` (encrypted blob fragment).
- **`input_json_delta`** — for `tool_use` blocks. Field: `partial_json` (a fragment of the JSON-encoded tool input).

### `content_block_stop`

Marks a content block complete. Just `index`. After this event, the corresponding `assistant` event for that block fires (carrying the fully-assembled block in `message.content`).

### `message_delta`

Message-level metadata update. Carries `delta` (typically `stop_reason: "end_turn" | "tool_use"`, `stop_sequence`, `stop_details`) and final `usage` for the message. Emits once per model API call, near the end.

### `message_stop`

Marks the model message complete. Just the type, no additional fields beyond the wrapper.

---

## Cross-cutting concepts

### `parent_tool_use_id`: the subagent boundary

This field appears on `stream_event`, `assistant`, and `user` events. It's the key to knowing what level of the agent hierarchy an event belongs to.

- **`null`** = top-level. The parent model is responsible.
- **Set to the Agent tool's `tool_use_id`** = inside a subagent. The subagent (running on a different model in our scenario — Haiku) is responsible.

A consumer that wants to render the parent's narrative cleanly can filter by `parent_tool_use_id === null` and group everything else under the relevant Agent tool_use. The `system/task_*` events provide a higher-level summary of the subagent's activity if we don't want to render its internal events.

### `message.id`: the Turn boundary

Within a single Query, multiple `assistant` events can share `message.id`. They represent one model message delivered incrementally as content blocks complete. To assemble a Turn:

1. Group `assistant` events by `message.id`.
2. Concatenate their `message.content` arrays in event order.
3. Use the `stream_event` of `type: "message_delta"` with the same `message.id` to know the message's final `stop_reason` and `usage`.

**Important:** the SDK's `result` event's `num_turns` counts *unique `message.id`s at the top level*, not content blocks. Subagent message ids are not counted (or are counted under the parent's tool-use turn — needs verification).

### `tool_use_id`: the tool call linkage

Every tool_use block carries an `id`. Every tool_result references it via `tool_use_id` (either at `content[0].tool_use_id` for tool_result content, or in `parent_tool_use_id` when the tool spawned a nested context like a subagent).

Walking the chain:
- Parent's `assistant` event with `tool_use` block (id = X)
- Top-level `user` event with `content[0].tool_use_id = X` (the result coming back)
- For a subagent: also `parent_tool_use_id = X` on every event from the subagent's internal stream

---

## What this catalogue *doesn't* cover (and we're choosing not to handle)

The full SDK union has ~25 variants. We've only observed 10 (counting subtypes). Variants the SDK can emit but we don't observe in our scenarios — and don't need to handle — include:

- `system/api_retry` — would fire on transient API errors mid-Query
- `system/compact_boundary` — context compaction in long sessions
- `system/hook_*` — hook-related events
- `system/plugin_install` — plugin installation
- `system/memory_recall` — memory retrieval
- `system/elicitation_complete` — interactive elicitation
- `prompt_suggestion` — predicted next prompt
- `auth_status` — auth flow events
- `result/error_during_execution`, `result/error_max_turns`, `result/error_max_budget_usd` — error terminal subtypes (we handle the success path; error paths need a future spike when we can trigger them safely)

If any of these surface in real usage we'll need to update. The translation layer can default to "ignore unknown event variants gracefully" so unexpected types don't break us.

---

## Implications for DOMAIN_MODEL.md

These need to be reflected in Layer 2 / D2 when we revise it:

1. **Turn definition revision:** A Turn is one model message identified by `message.id`, *not* one `assistant` event. Multiple `assistant` events per Turn (one per content block) is normal.
2. **Turn shape revision:** `{ text, tool_calls[] }` is incomplete. Real Turns have an *ordered* sequence of blocks of three types: `text`, `thinking`, `tool_use`. Block ordering carries semantic meaning (e.g., text-then-tool_use means "I'm going to do X").
3. **Subagent handling:** ManagedQuery's `turns` should probably represent the *parent's* turns only. Subagent turns can be either ignored (only show the Agent tool's final result) or rendered as a nested structure inside the parent's Agent tool_use block. Either is consistent with D2 — the choice is a UX call.
4. **`thinking` blocks:** Mostly empty in our runs (just signature blobs). Probably skip in rendering, but acknowledge in the model.
5. **The synthetic `user` event taxonomy is non-trivial.** Layer 3 (Translation) will need to disambiguate the four shapes when mapping to ManagedQuery state changes.
