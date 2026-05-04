# Pocket Claude - Domain Model

## Purpose

This document defines the conceptual model of pocket_claude as a deliberate exercise, separate from whatever shape the current code happens to have. It exists because the current code grew reactively - "whatever solved the problem at the time" - and the seams in the implementation are artifacts of that growth, not principled boundaries. The current code conflates two distinct concerns into one "Message" model:

- The **SDK's behavior** (what `@anthropic-ai/claude-agent-sdk` emits, accepts, and commits us to)
- The **app's domain** (what pocket_claude needs to manage and present, defined by the chat UX it serves)

When those two concerns share a model, every change has to thread through both. SDK quirks leak into domain logic. Domain decisions get tangled in SDK event handling. The result feels unweildy because the layers don't reflect a clear conceptual model.

The goal of this doc is to produce a model where:

1. The app domain is defined in app's own terms, with no SDK leakage
2. The SDK contract is documented as an external system we depend on, not as part of our domain
3. There is one explicit translation layer between them, and it is the only place SDK concepts touch app concepts

The downstream consequences (architecture, language choice, OAuth refresh implementation) follow from the model. Decisions made here will become ADRs.

---

## The Boundary

Three layers. Crossings between them are explicit and bounded.

```
+------------------------------------------+
|  App Domain                              |
|  (Conversation, ManagedQuery, Turn)       |
|  Defined by what the chat UX needs.      |
|  Knows nothing about the SDK.            |
+--------------------+---------------------+
                     |
                     |  Translation Layer
                     |  (event mapping, FSM, session lifecycle,
                     |   credential management)
                     |
+--------------------+---------------------+
|  SDK Contract                            |
|  (events, sessions, turns, credentials)   |
|  Defined by Anthropic's claude-agent-sdk. |
|  External system we depend on.            |
+------------------------------------------+
```

The translation layer is the only code that imports the SDK. Everything above the boundary works with app domain types.

---

## Layer 1: SDK Contract

What the SDK emits, what it accepts, what its session/turn model commits us to. Treated as an external system - we document its shape, we don't get to redesign it.

**Naming convention.** A single `query()` invocation is a **Query**. What flows through a Query is a stream of **events**. The word "Message" is reserved for the App Domain and is not used on this side of the boundary, even though the SDK's TypeScript union for its event taxonomy is unfortunately named `SDKMessage` (and its variants `SDKAssistantMessage`, `SDKUserMessage`, etc.). We cite those type names verbatim when referencing source, and use "event" / "Query event" in our own prose.

### Inputs (what we hand the SDK)

Entry point: `query({ prompt, options }): Query` (sdk.d.ts:1893).

`prompt` accepts:
- `string` for single-shot input (what we use today)
- `AsyncIterable<SDKUserMessage>` for streaming user input (mid-session steering, multi-turn injection mid-flight)

`options` (selected fields, with usage marked):

| Field | Type | Used? | Notes |
|---|---|---|---|
| `cwd` | `string` | yes | working directory |
| `abortController` | `AbortController` | yes | the only cancellation mechanism |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` | yes (`bypassPermissions`) | may require `allowDangerouslySkipPermissions: true` paired |
| `systemPrompt` | `string \| { type: 'preset', preset: 'claude_code', append?, excludeDynamicSections? }` | yes (preset+append) | preset mode extends the default Claude Code prompt without overriding it |
| `settingSources` | `('user' \| 'project' \| 'local')[]` | yes (`['project']`) | empty array = SDK isolation (no file-based config). Omitting loads defaults. |
| `includePartialMessages` | `boolean` | yes (`true`) | enables `stream_event` emission |
| `resume` | `string` (session UUID) | yes (when present) | loads prior session history |
| `resumeSessionAt` | `string` (message UUID) | no | rewind a resumed session to a specific point |
| `forkSession` | `boolean` | no | branch session into a new ID while loading prior history |
| `model` | `string` | no | override model (defaults to CLI default) |
| `maxTurns` | `number` | no | caps the agent loop inside one query() (see "Session / turn model") |
| `maxBudgetUsd` | `number` | no | cost cap; emits `error_max_budget_usd` result if exceeded |
| `canUseTool` | `(toolName, input, options) => Promise<PermissionResult>` | no | custom permission handler; mutually exclusive with `bypassPermissions` |
| `think` | `{ type: 'adaptive' \| 'enabled', budgetTokens? }` | no | extended thinking control |
| `getOAuthToken` | `({ signal }) => Promise<string \| null>` | no | **not in public types** - see "Credentials and auth" |

Notable: credentials are NOT passed via `options`. The SDK sources them from disk/env. The exception is `getOAuthToken`, which is not a credential but a refresh callback.

### Outputs (what the SDK emits)

A Query yields a stream of events, typed as the discriminated union `SDKMessage` (sdk.d.ts:2555) with `type` as the discriminator. ~25 variants total. We currently observe three (`assistant`, `stream_event`, `result`).

**Per-event shape for variants we observe:**

- `assistant`
  - Payload: `{ message: BetaMessage, parent_tool_use_id, error?: SDKAssistantMessageError, uuid, session_id }`
  - `message.content` is the canonical full text **for that turn** (see "Session / turn model" - "that turn" is load-bearing because one query() can emit multiple `assistant` events).
  - `error` field values (sdk.d.ts:2009): `authentication_failed | billing_error | rate_limit | invalid_request | server_error | unknown | max_output_tokens`. **Currently not inspected.**
- `stream_event`
  - Payload: `{ event: BetaRawMessageStreamEvent, parent_tool_use_id, uuid, session_id, ttft_ms? }`
  - The sub-event taxonomy lives in `@anthropic-ai/sdk` (not this package). Includes `content_block_start`, `content_block_delta`, `content_block_stop`, plus message-level framing.
  - This is the **only** path to observe tool lifecycle - the `assistant` event arrives with content already assembled.
- `result` - terminal event, always emitted, ends the iterator. Payload includes `duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage`, `result: string`, `permission_denials[]`, `terminal_reason?`, `uuid`, `session_id`. Subtypes:
  - `success`
  - `error_during_execution` - with `errors: string[]`
  - `error_max_turns`
  - `error_max_budget_usd`
  - **Currently not distinguished** - all results land in the success path.

**System events we ignore that may matter:**

- `system/init` - first event in any query. Reports detected `apiKeySource`, `tools`, `mcp_servers`, `model`, `permissionMode`. Useful for verifying environment wiring.
- `system/api_retry` - transient API error with retry count. Could surface as UX hint ("retrying...").
- `system/compact_boundary` - SDK compacted context mid-session. Worth knowing in long sessions.
- `system/status` - `compacting | requesting | null` state markers.
- Other variants exist for hooks, subagents, task tracking, MCP plugin install, memory recall, prompt suggestions, rate limit events, elicitation. Out of scope for current usage but documented in `SDKMessage` union.

**`session_id` is populated on every event**, not just `result`. We currently only extract it from the terminal `result`.

### Session / turn model

A **session** is a persistent conversation thread, stored as JSONL in `~/.claude/projects/` (or project-local `.claude/`). Each session has:
- A stable `session_id` (UUID)
- Full event history (user-role events, assistant events, tool results)
- Metadata (cwd, git branch, etc.)

The SDK manages session storage transparently. There is no API to manipulate session files from the consumer.

**Critical: a single Query can span multiple agentic turns.**

When Claude wants to call tools, the SDK loops *inside* one Query:

1. Claude responds with `tool_use` blocks → SDK emits `assistant` event + `stream_event`s
2. Tool executes (via `bypassPermissions` or `canUseTool` callback)
3. Tool result fed back as a synthetic user-role event (SDK internal)
4. Claude responds again → another `assistant` event + `stream_event`s
5. Loop until no more tool calls (or `maxTurns` hit)
6. Single terminal `result` event, iterator ends

So one Query may emit **N `assistant` events** before terminating, where N ≥ 1. The `message.content` on each `assistant` event is the full text *for that turn*, not for the whole Query.

The App Domain section needs to decide what unit, if any, corresponds to one Query - and what units, if any, correspond to individual assistant turns within a Query.

**Resume semantics:**

| Option | Behavior |
|---|---|
| `resume: sessionId` | Loads all prior events from the named session before this query starts. New turn appended to that session. Same `session_id` continues. |
| `resume: sessionId, resumeSessionAt: eventUuid` | As above, but loads only up to `eventUuid`. "Rewind and continue from here." |
| `forkSession: true` (with `resume`) | Loads prior history but assigns a new `session_id`. Branch the conversation. |
| neither | New session, new `session_id` generated by SDK. |

The `session_id` we store on `conversations.session_id` is what the SDK gives us in the first Query's `result`, and what we pass as `resume` on subsequent Queries in the same conversation.

**"Turn" is not a first-class type** in the public API. It's an implicit concept (= one user-role event + one assistant response, possibly with tool loops). Each `assistant` event is one turn.

### Credentials and auth

The SDK does not accept credentials via `options`. It sources them from:

- `~/.claude/.credentials.json` - OAuth file with `claudeAiOauth.{accessToken, refreshToken, expiresAt, subscriptionType, scopes}`
- `ANTHROPIC_API_KEY` env var - direct API key (different billing model)
- `CLAUDE_CODE_OAUTH_TOKEN` env var - bypass file I/O, supply OAuth token directly
- Cloud provider creds (AWS / GCP) for Bedrock / Vertex backends
- OAuth login flow (interactive, only available with TTY)

Detected credential identity is reported in the `system/init` event's `apiKeySource` field. See also `AccountInfo` type (sdk.d.ts:23-33) with `tokenSource: 'user' | 'project' | 'org' | 'temporary' | 'oauth'` and `apiProvider: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle'`.

**Token refresh:** the SDK supports an OAuth refresh callback `getOAuthToken({ signal }) => Promise<string | null>` passed in `options`. **This callback is not in the public TypeScript types.** From source inspection (cli.js, sdk.mjs):

- Passing `getOAuthToken` sets env var `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`
- The bundled CLI honors that flag and issues `oauth_token_refresh` control requests back to the parent SDK process when it needs a fresh token
- The SDK fulfills the request by invoking `getOAuthToken`; the returned string becomes the new bearer token
- Without `getOAuthToken`, refresh is silently disabled - the SDK reads `.credentials.json` once and uses its `accessToken` indefinitely

This is the gap that surfaces as 401s after the token's natural expiry (~24h on the host's `.credentials.json`). The host's interactive `claude` CLI normally refreshes the file periodically; in a container on a non-interactive host, nothing refreshes it and the access token rots.

Auth failures appear as:
- `assistant.error: 'authentication_failed'`
- `result` with `error_during_execution`
- (No separate auth event type in the consumer-facing taxonomy.)

### Failure modes

**The iterator does not throw on most failures.** Errors are values, surfaced via `result` event subtype or `assistant.error` field. The only typed exception class is `AbortError extends Error` (sdk.d.ts:17).

| Failure | How it surfaces |
|---|---|
| Spawn / invalid options | `query()` throws on first `.next()` (caught in our outer try/catch) |
| `abortController.abort()` | iterator stops; may emit `result` with `terminal_reason`; `AbortError` may be thrown depending on iteration timing |
| API request retryable (5xx, transient) | transparent retry; emits `system/api_retry` for visibility |
| API request fatal (4xx non-auth, persistent) | `result` with `error_during_execution`, `errors: string[]` |
| Auth failure (401) | `assistant.error: 'authentication_failed'` + `result` (subtype undocumented but likely `error_during_execution`) |
| Rate limit | `assistant.error: 'rate_limit'` |
| Billing | `assistant.error: 'billing_error'` |
| Server error | `assistant.error: 'server_error'` |
| Invalid request | `assistant.error: 'invalid_request'` |
| Max output tokens | `assistant.error: 'max_output_tokens'` |
| `maxTurns` exceeded | `result` with subtype `error_max_turns` |
| `maxBudgetUsd` exceeded | `result` with subtype `error_max_budget_usd` |
| Permission denials | recorded in `result.permission_denials[]`; iteration **continues** (denial is not fatal unless `interrupt: true` returned by `canUseTool`) |

**`abortController` is the only cancellation mechanism.** There is no per-request timeout in the SDK - external timeout (current code uses 10 minutes) must drive abort.

**Implication for the domain model:** the translation layer needs to handle three distinct terminal causes - clean success, SDK-surfaced error (assistant.error or result subtype), and abort/timeout. None of them throw; all of them must be detected by inspecting events. This is a contrast with idiomatic exception-driven error handling.

---

## Layer 2: App Domain

The data model pocket_claude needs in its own terms. Defined by UX requirements (durable execution, reconnect catch-up, real-time tool activity, per-unit lifecycle), not by what the SDK happens to emit.

The central app-domain unit is the **ManagedQuery** - the app's wrapper around one SDK Query, with the lifecycle, persistence, and projection the app needs around it. One ManagedQuery corresponds 1:1 with one `query()` invocation. It retains the structural fidelity of the underlying Query (N assistant turns, interleaved tool activity) inside its content shape, rather than collapsing them into flat text.

### Conversation

A thin owner of one SDK session and the ordered list of ManagedQueries against that session. Carries no per-turn state of its own.

**State:**
- `id` - stable app-side identity
- `session_id` - the SDK session UUID. Populated after the first ManagedQuery's terminal `result` event; reused as `resume` on every subsequent Query in this Conversation.
- `cwd` - working directory passed to every Query in this Conversation
- `created_at`, `updated_at`

**No status field.** Status of in-flight work is a property of the active ManagedQuery, not of the Conversation. A Conversation does not have a meaningful "running" or "stopped" state - those concepts only make sense at the Query level.

**Lifecycle:** created on the first user prompt; lives indefinitely; no terminal state.

**History:** the ordered list of ManagedQueries owned by this Conversation. The user-visible "transcript" is derived by walking the ManagedQueries in order and rendering each one's structured content.

### ManagedQuery

The app-domain wrapper around one SDK Query. One ManagedQuery exists for every `query()` invocation, 1:1.

**Identity / persisted state:**
- `id` - stable app-side identity
- `conversation_id` - FK to owning Conversation
- `prompt` - the user-side input that initiated this Query (currently a string; could be richer later, e.g. structured input with attachments)
- `in_progress: boolean` - true while the SDK Query is executing; flips false on terminal `result`, abort, or error
- `turns: Turn[]` - ordered list of completed Turns. Each Turn is one finished `assistant` event from the underlying Query (text + the tool calls Claude made during that turn, with their results)
- terminal info - status (success / SDK-error / abort) and any error details. Exact shape is an open question (see Decisions / Open questions under D2)
- `created_at`, `updated_at`

**Runtime API surface:**

```
.in_progress              // boolean - read-only
.turns                    // Turn[] - read-only access to completed turns
.callback_turn(fn)        // register a handler fired each time a turn completes (passes the new Turn)
.callback_fin(fn)         // register a handler fired once when the Query terminates
```

This is the entire surface the rest of the app consumes. No event bus, no observable streams - three properties and two callback registrations.

**Turn shape (proposed, open for revision):**

```
Turn {
  text: string                  // model's textual output for this turn
  tool_calls: ToolCall[]         // tool_use blocks Claude issued this turn, with results
}

ToolCall {
  tool_name: string
  input: any                     // model's input to the tool
  output: any                    // tool_result returned to the model
  status: 'success' | 'error'
}
```

**Lifecycle.** Created when the user submits a prompt. The translation layer issues the SDK Query, observes events, and updates ManagedQuery state:
- Each completed `assistant` event from the Query becomes a new Turn appended to `.turns`; `callback_turn` fires with the new Turn.
- The terminal `result` event (or abort, or error) flips `.in_progress` to false; `callback_fin` fires once.
- All state changes are persisted as they happen, so the ManagedQuery's persisted state is current at any moment - the catch-up surface (see below) returns it as-is.

### ToolEvent

**Not a separate top-level entity.** Tool activity is encoded inside `Turn.tool_calls` on the ManagedQuery that contains the turn it happened in. There is no top-level ToolEvent table, no FK back from tool data to ManagedQuery, no cross-ManagedQuery tool index.

**Rationale.** No usage requires querying tool activity across ManagedQueries (e.g., "show me every Bash command this week"). Lifting ToolEvent to a top-level entity would impose denormalization and a sync burden between two sources of truth without a corresponding usage benefit.

If cross-ManagedQuery tool indexing is wanted later, it can be added as a derived/projected view rather than a primary store.

### Catch-up surface

When the phone reconnects, the catch-up object for a Conversation is:

```
{
  conversation: Conversation,
  managed_queries: ManagedQuery[]   // ordered, with full structured turns and in_progress status
}
```

The phone reconstructs UI state from this object alone. Each ManagedQuery's `turns` reflects what's been completed up to the moment of fetch; if any ManagedQuery is still in flight (`in_progress: true`), the phone knows to attach to its live event stream for further updates.

The same structural shape exposed via the runtime callbacks (Turn objects appended to `.turns`) is what's rendered from the persisted state. There is no separate "catch-up shape" vs "live shape" - they are the same shape, served from different sources (DB on reconnect, in-memory during live execution).

### What the UI consumes

The renderer operates over **structured ManagedQuery content**, not flat text. For each ManagedQuery in a Conversation's history, the renderer walks `.turns` in order and renders each Turn as a visual segment:

- The Turn's `text` content (model's reasoning/response for that turn)
- The Turn's `tool_calls` rendered inline as collapsible cards (similar to current implementation: tool name, target, status, expandable input/output)

Multi-turn agentic responses are structurally visible: a Query where Claude reasoned, called a tool, then continued reasoning shows up as multiple visual turns separated by tool cards, rather than a single wall of concatenated text with tool cards interleaved by timestamp.

The user's own prompt (the `prompt` field on the ManagedQuery) renders before the Turns as the user-side bubble.

Implications for the renderer (compared to a string-to-bubble model):
- Renderer is a structure walker, not a string formatter
- Each Turn is independently scrollable / addressable
- Tool cards have a clear parent (the Turn they were issued in), enabling per-turn collapse

---

## Layer 3: Translation

The single place SDK concepts touch app concepts. Owns: event mapping, FSM transitions driven by SDK events, session resume, credential refresh, abort/timeout handling.

### Event mapping

_(to fill - SDK events in, app domain state changes out. What's the taxonomy?)_

### Session lifecycle

_(to fill - how an app Conversation's lifetime relates to SDK session resumption across multiple prompts)_

### Credential management

_(to fill - the `getOAuthToken` callback, refresh logic, where credentials live)_

### Abort / timeout / failure

_(to fill - how SDK errors and aborts become app-domain terminal states)_

---

## Cross-cutting concerns

Things that touch all three layers and need explicit handling.

### Durable execution

_(to fill - server owns execution from prompt acceptance to terminal state, regardless of client connectivity)_

### Persistence

_(to fill - what gets written when, single source of truth)_

### Real-time delivery (SSE)

_(to fill - what's pushed to the client and when, what's pull-only via REST)_

---

## Open questions

_(running list as we work)_

### Defects in current implementation (do not fix; rewrite must avoid)

These are not items to patch in the current code - they're flagged here as evidence of where the conflated model led us astray, and as requirements the rewrite's translation layer must handle correctly.

- **Result subtypes are not distinguished.** `process-manager.ts:178-183` calls `session.complete(sessionId)` for every `result` event regardless of whether the subtype is `success`, `error_during_execution`, `error_max_turns`, or `error_max_budget_usd`. The FSM's `error` terminal state is unreachable through the SDK happy path; only the outer catch block can land us there.
- **`assistant.error` field is not inspected.** Auth failures (401), rate limits, billing errors, and other inline assistant-level errors are silently ignored. They flow through as if the assistant message succeeded.
- **N-assistant-events-per-query collapsed into one Message.** Current code accumulates text from every `assistant` event in a single `query()` call into one `MessageSession` via `appendContent()`. Tool-using sessions emit multiple `assistant` events (one per agentic turn); we concatenate them, flattening the structural reality.
- **`session_id` extracted only from terminal `result`.** It's available on every event; using the terminal source is fine for our current use but couples session-id-availability to query completion.

---

## Decisions

_(captured here, then promoted to ADRs in `docs/adr/` once finalized)_

### D1: App-domain unit per SDK Query is a ManagedQuery, with structured content

**Decision.** The app-domain unit corresponding to one SDK `query()` invocation is named **ManagedQuery**. There is one ManagedQuery per Query (1:1). Its content is a structured shape (sequence of turn-segments + interleaved tool activity), not flat text.

**Rejected alternatives:**

- *Flat-text concatenation per Query (current code's implicit model).* Loses structural fidelity of multi-turn agentic responses. Cheap but blind.
- *One app-domain unit per assistant turn (N per Query).* Domain-honest to the SDK's emission pattern, but requires an additional grouping concept to relate sibling turns from the same Query. More moving parts than the chosen option.

**Reasoning.** Preserves 1:1 correspondence with the SDK's unit of work (no grouping wrapper needed). Retains structural fidelity - the multi-turn shape of an agentic response is visible in the data, not flattened. Names the boundary explicitly: "Managed" announces "this is the SDK's Query, with the lifecycle and persistence we wrap around it."

**Consequences / open questions to resolve in Layer 2:**

- The structured content shape needs definition (segment types, ordering, tool event placement)
- Persistence likely JSON-shaped rather than a flat text column
- UI renderer consumes structure, not a string - more complex than a "string to bubble" mapping
- Whether ToolEvent remains a separate top-level entity (for cross-ManagedQuery indexing) or becomes a segment-type inside ManagedQuery.content is open *(resolved in D2: not a separate entity)*

### D2: Layer 2 entities and ManagedQuery API surface

**Decision.**

- **Conversation** is a thin owner: `id`, `session_id`, `cwd`, timestamps. No status field. Its history is the ordered list of its ManagedQueries.
- **ManagedQuery** wraps one SDK Query 1:1. Persisted state includes `prompt`, `in_progress`, `turns`, terminal info. Runtime API surface is exactly four members:
  - `.in_progress: boolean`
  - `.turns: Turn[]` (completed turns only)
  - `.callback_turn(fn)` — fires per completed Turn
  - `.callback_fin(fn)` — fires once on terminal
- **Turn** is the unit of `.turns`. One Turn corresponds to one finished `assistant` event from the underlying SDK Query. Proposed shape: `{ text: string, tool_calls: ToolCall[] }`.
- **ToolEvent is not a separate top-level entity.** Tool activity is encoded inside `Turn.tool_calls`. No cross-ManagedQuery tool index.

**Reasoning.**

- Conversation thinness mirrors the SDK's own session model — there is no per-conversation status the SDK exposes either, only per-Query terminal info. Adding one in our model would be inventing state without a referent.
- The minimal four-member API on ManagedQuery (three properties + two callback registrations — `.in_progress`, `.turns`, `.callback_turn`, `.callback_fin`) keeps the surface small and easy to reason about. No event bus, no observable streams, no multi-listener semantics to debate. Two callback hooks cover the two interesting moments (per-turn and terminal); everything else is read off the properties.
- Turn-as-segment preserves the structural fidelity that D1 chose Option C for, without inventing a separate Message concept. A Turn is exactly what the SDK emits as one `assistant` event, no more no less.
- Skipping a top-level ToolEvent removes a source of denormalization burden (sync between two stores) that no current usage requires. If cross-ManagedQuery tool indexing becomes wanted, it can be added later as a derived view.

**Open questions / consequences for Layer 3:**

1. **callback_fin signature.** Does it fire on all terminal states (success / SDK-error / abort) with a status argument? Or only on success, with a separate `callback_err` for failure paths? The choice depends on whether observers typically care about distinguishing terminal kinds.
2. **In-progress turn visibility.** `.turns` holds finished Turns by spec. The currently-emitting Turn is invisible until it completes. Is that intentional (clean), or do we want a `.partial_turn` accessor for liveness during long turns?
3. **Runtime vs persistence semantics.** Does the ManagedQuery API operate over in-process state only (live during one Query execution), or does it reconstruct from DB on phone reconnect (so a phone that wakes mid-Query can attach callbacks and observe future turns)? Strictly a Layer 3 question, but it shapes whether the ManagedQuery API is "object-with-handlers" vs "view-over-event-stream."
4. **Turn block taxonomy.** Proposed shape is `{ text, tool_calls }`. Real `assistant` events have ordered content blocks (text→tool_use→text→tool_use is common). Do we need to preserve block ordering inside a Turn, or is "text + tool_calls separately" sufficient for our UX?
5. **Persistence column shape.** ManagedQuery's `turns` is structured — likely a JSONB column rather than separate rows. Schema definition deferred to implementation.
