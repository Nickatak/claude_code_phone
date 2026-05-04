# SDK Glossary

Terms used by `@anthropic-ai/claude-agent-sdk` and how we refer to them in this project. Alphabetical. Where the SDK's own naming and our naming diverge, both are noted - this is by design (see [DOMAIN_MODEL.md](DOMAIN_MODEL.md), Layer 1, "Naming convention").

This glossary covers SDK-side terms only. App-domain terms (ManagedQuery, Turn, ToolCall, etc.) are defined in [DOMAIN_MODEL.md](DOMAIN_MODEL.md), Layer 2.

---

### `AbortError`

The only typed exception class the SDK throws. Subclass of `Error`. May be thrown when `abortController.abort()` is called mid-iteration. Most failures are values (in `result` events), not exceptions - `AbortError` is the exception. (sdk.d.ts:17)

### `abortController`

An `AbortController` instance passed in `query()` options. The only cancellation mechanism the SDK exposes. Calling `.abort()` on it stops the Query mid-execution. There is no per-request timeout; an external timeout must drive abort.

### `AccountInfo`

Type describing the logged-in user's account. Fields include `email`, `organization`, `subscriptionType`, `tokenSource` (`'user' | 'project' | 'org' | 'temporary' | 'oauth'`), `apiKeySource`, `apiProvider`. (sdk.d.ts:23-33)

### agentic loop

The implicit loop inside one Query where Claude makes a tool call, the tool executes, the result is fed back, and Claude responds again. Repeats until no more tool calls or `maxTurns` hit. Not a first-class type in the API; the consumer observes it as multiple `assistant` events between Query start and the terminal `result`.

### `allowDangerouslySkipPermissions`

Boolean option that must be paired with `permissionMode: 'bypassPermissions'` in some SDK versions.

### `ANTHROPIC_API_KEY`

Environment variable for direct API key authentication. Bypasses OAuth entirely. Different billing model than the Max-subscription OAuth path.

### `ApiKeySource`

Enum-like type categorizing where the SDK detected its credentials from. Reported in the `system/init` event's `apiKeySource` field.

### `apiProvider`

Field on `AccountInfo`. One of `'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle'`. Indicates which backend the SDK is talking to. Anthropic OAuth login only applies when `'firstParty'`.

### `assistant` (event type)

Discriminator value for `SDKAssistantMessage` events. Fired when Claude emits a complete response turn. Payload includes `message: BetaMessage` with the full text content for *that turn* (load-bearing - one Query may emit multiple `assistant` events).

### `BetaMessage`

Type from `@anthropic-ai/sdk` representing a complete assistant response. Contains a `content` array of typed blocks (text, tool_use, etc.). Included as the `message` field of `assistant` events.

### `BetaRawMessageStreamEvent`

Type from `@anthropic-ai/sdk` for individual streaming events. Wrapped inside `stream_event` events. Sub-event taxonomy includes `content_block_start`, `content_block_delta`, `content_block_stop`, plus message-level framing.

### `canUseTool`

Optional callback in `query()` options for custom permission handling. Signature: `(toolName, input, options) => Promise<PermissionResult>`. Mutually exclusive with `permissionMode: 'bypassPermissions'`.

### `CLAUDE_CODE_OAUTH_TOKEN`

Environment variable to supply an OAuth bearer token directly, bypassing the `~/.claude/.credentials.json` file lookup.

### `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`

Internal environment variable the SDK sets to `"1"` when a `getOAuthToken` callback is provided. The bundled CLI honors this flag and issues `oauth_token_refresh` control requests when it needs a fresh bearer token.

### `claudeAiOauth`

The single top-level key in `~/.claude/.credentials.json`. Object with fields `accessToken`, `refreshToken`, `expiresAt`, `subscriptionType`, `scopes`.

### `compact_boundary` (system event subtype)

Fired when the SDK compacts session context mid-Query. Worth knowing in long sessions; we currently ignore it.

### `content_block_delta`

Sub-event type inside a `stream_event`. Carries an incremental text or tool-input delta during streaming.

### `content_block_start`

Sub-event type inside a `stream_event`. Marks the beginning of a content block (text or tool_use) within an assistant response.

### `content_block_stop`

Sub-event type inside a `stream_event`. Marks the end of a content block.

### control request

A request the bundled CLI sends back to the parent SDK process. The currently-known one is `oauth_token_refresh`, used to fetch a fresh bearer token via the `getOAuthToken` callback.

### `cwd`

`query()` option specifying the working directory for the Query. Defaults to `process.cwd()`.

### `error_during_execution` (result subtype)

A `result` event subtype indicating non-retryable execution failure. Carries `errors: string[]` with detail.

### `error_max_budget_usd` (result subtype)

A `result` event subtype indicating the `maxBudgetUsd` cap was exceeded.

### `error_max_turns` (result subtype)

A `result` event subtype indicating the `maxTurns` cap was exceeded.

### event

Our preferred term for what flows through a Query. The SDK's TypeScript union for these is unfortunately named `SDKMessage`; we cite the type name verbatim when referencing source but use "event" in our prose to keep "Message" reserved for the App Domain.

### `expiresAt`

Field in `claudeAiOauth` (in `~/.claude/.credentials.json`). Unix timestamp (milliseconds) when the access token stops being accepted.

### `forkSession`

`query()` option (boolean, used with `resume`). Loads prior history but assigns a new `session_id`, branching the conversation.

### `getOAuthToken`

A callback passed in `query()` options with signature `({ signal }) => Promise<string | null>`. The SDK invokes it to refresh the OAuth bearer token. **Not in the public TypeScript types** - documented from source inspection. Without this callback, OAuth refresh is silently disabled.

### `includePartialMessages`

`query()` option (boolean). When `true`, the Query emits `stream_event` events with streaming sub-events. Required for observing tool lifecycle.

### `init` (system event subtype)

The first event in any Query. Reports detected `apiKeySource`, `tools`, `mcp_servers`, `model`, `permissionMode`. Useful for verifying environment wiring; we currently ignore it.

### `maxBudgetUsd`

`query()` option capping the cost of a Query. Emits `error_max_budget_usd` result if exceeded.

### `maxTurns`

`query()` option capping the number of agentic loop iterations inside a Query. Emits `error_max_turns` result if exceeded.

### MCP / `mcp_servers`

Model Context Protocol. The SDK can host MCP servers for tool integration. The `system/init` event reports detected MCP servers. Out of scope for our current usage.

### `model`

`query()` option to override the Claude model used. Defaults to whatever the CLI defaults to.

### `oauth_token_refresh`

Name of the control request the bundled CLI sends to the SDK when it needs a fresh bearer token. Handled by invoking `getOAuthToken`.

### `options`

The second field of the `query()` argument object. Carries Query configuration (`cwd`, `permissionMode`, `systemPrompt`, etc.). See [DOMAIN_MODEL.md](DOMAIN_MODEL.md) Layer 1 - "Inputs" for the full table.

### `parent_tool_use_id`

Field on `assistant` and `stream_event` payloads. Identifies the parent tool invocation when an event is emitted as part of a subagent's execution. Null at the top level.

### `permissionMode`

`query()` option controlling tool permission behavior. Values: `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. We use `'bypassPermissions'`.

### `permission_denials`

Array on `result` event payload. Records tool calls that were denied during execution. A denied tool is recorded but does not terminate the Query.

### `PermissionResult`

Return type of the `canUseTool` callback. Communicates whether the tool may run, with optional `interrupt: true` to terminate the Query.

### preset (system prompt)

A value of `systemPrompt.type`. Currently the only documented preset is `'claude_code'`, which loads the default Claude Code system prompt. Allows `append` for extension and `excludeDynamicSections` for trimming.

### `prompt`

First field of the `query()` argument object. Either a `string` (single-shot) or an `AsyncIterable<SDKUserMessage>` (streaming user input for mid-Query steering).

### Query

Our term for one invocation of `query()`. The SDK's unit of work. May span multiple agentic turns internally. Not the same as the SDK's TypeScript type also named `Query` (which is the iterator returned by the function).

### `query()`

The SDK's main entry point. Signature: `({ prompt, options }) => Query`. Returns an async iterable of events.

### `resume`

`query()` option (string, session UUID). Loads all prior events from the named session before this Query starts. Enables multi-turn conversation across separate Query invocations.

### `resumeSessionAt`

`query()` option (string, event UUID). Used with `resume`. Loads only up to the named event ("rewind" the session).

### `result` (event type)

Discriminator value for `SDKResultMessage`. Always emitted, terminates the iterator. Subtypes: `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`. Payload includes `duration_ms`, `total_cost_usd`, `usage`, `result: string`, `permission_denials`, `terminal_reason`, `session_id`, etc.

### `SDKAssistantMessage`

TypeScript variant of the `SDKMessage` union for `assistant` events.

### `SDKAssistantMessageError`

Type of the `error` field on `SDKAssistantMessage`. Discriminator values: `authentication_failed | billing_error | rate_limit | invalid_request | server_error | unknown | max_output_tokens`. (sdk.d.ts:2009)

### `SDKMessage`

The discriminated union type for all events a Query yields. ~25 variants. Discriminator field is `type` (and for system events, also `subtype`). (sdk.d.ts:2555). We refer to these as "events" rather than "messages" to keep the vocabulary boundary clean.

### `SDKPartialAssistantMessage`

TypeScript variant of `SDKMessage` for `stream_event` events. Emitted when `includePartialMessages: true`.

### `SDKResultMessage`

TypeScript variant of `SDKMessage` for `result` events.

### `SDKUserMessage`

TypeScript variant for `user`-typed events. Used both as input (in `AsyncIterable<SDKUserMessage>` prompt mode) and as the type of the synthetic user-role events the SDK emits internally between agent turns to feed tool results back to Claude.

### session

A persistent conversation thread managed by the SDK. Stored as JSONL in `~/.claude/projects/` or project-local `.claude/`. Identified by a stable `session_id` UUID. Created automatically; loaded via the `resume` option.

### `session_id`

UUID identifying a session. Populated on every event the Query emits. The SDK generates one per new session; we store it so we can pass it as `resume` on subsequent Queries in the same conversation.

### `settingSources`

`query()` option. Array of `'user' | 'project' | 'local'` indicating which config layers to load. Empty array (`[]`) means SDK isolation - no file-based config. Omitting the option loads defaults.

### `status` (system event subtype)

Internal state markers: `compacting | requesting | null`. Mostly internal; we ignore.

### `stream_event` (event type)

Discriminator value for `SDKPartialAssistantMessage`. Carries a `BetaRawMessageStreamEvent` in its `event` field. Only emitted when `includePartialMessages: true`. The only path to observe tool lifecycle (tool start, input deltas, completion).

### subagent / Agent tool

The SDK supports invoking subagents via a built-in Agent tool. Out of scope for our current usage; mentioned for completeness.

### `subscriptionType`

Field in `claudeAiOauth`. Values include `'max'` for Max subscriptions.

### `success` (result subtype)

The non-error subtype of `result`. Indicates the Query completed cleanly.

### `systemPrompt`

`query()` option. Either a `string` (full override) or `{ type: 'preset', preset: 'claude_code', append?, excludeDynamicSections? }` (extend the default).

### `terminal_reason`

Optional field on `result` payload. Carries a string describing why the Query terminated (e.g., abort cause).

### `think`

`query()` option for extended thinking control. Object: `{ type: 'adaptive' | 'enabled', budgetTokens?: number | 'disabled' }`.

### `tool_result`

The synthetic content the SDK feeds back to Claude after a tool executes during the agentic loop. Wrapped in a synthetic `user`-role event (an `SDKUserMessage`).

### `tool_use`

A content block type inside a `BetaMessage`. Indicates the model wants to invoke a tool. Carries the tool name and input. The SDK executes the tool (via `bypassPermissions` or `canUseTool`) and feeds the `tool_result` back automatically.

### `tokenSource`

Field on `AccountInfo`. One of `'user' | 'project' | 'org' | 'temporary' | 'oauth'`. Indicates which credential source the SDK is using.

### turn (SDK sense)

Implicit concept: one user-role event + one assistant response, possibly with a tool loop. Each `assistant` event is one turn. Not a first-class type in the API.

### `ttft_ms`

Field on `stream_event` payload. Time to first token, in milliseconds.

### `usage` / `modelUsage`

Fields on `result` payload reporting token usage. `usage` is overall; `modelUsage` is per-model breakdown if multiple models were involved in the Query.

### `uuid`

Field on every event payload. Unique identifier for that specific event within the session.

---

## See also

- [DOMAIN_MODEL.md](DOMAIN_MODEL.md) - Layer 1 (SDK Contract) for full prose context, Layer 2 for app-domain terms (ManagedQuery, Turn, ToolCall, Conversation as we use it)
- `~/tools/pocket_claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` - the authoritative type source
