# Pending regression tests — frontend

Two regressions were fixed in `public/app.js` without accompanying tests
because the project has no frontend test infrastructure yet. This doc
captures the test specs so they can be written later when the harness
exists.

## Frontend test harness — prerequisites

Both tests need:

- `jsdom` as a devDependency.
- A small bootstrap that:
  1. Builds the minimal DOM that `app.js` queries on load
     (`#messages`, `#prompt-input`, `#send-btn`, `#stop-btn`, `#sidebar`,
     `#sidebar-btn`, `#sidebar-close-btn`, `#conversation-list`,
     `#new-chat-btn`).
  2. Stubs `window.fetch` (capture calls, return canned JSON).
  3. Stubs `window.EventSource` (capture instances, expose a way to
     emit synthetic `onmessage` events).
  4. Stubs `window.marked.parse` (identity function is fine — these
     tests don't care about markdown rendering).
  5. Loads `public/app.js` into the jsdom window context. Easiest path:
     `fs.readFileSync` + `vm.runInContext` against the jsdom window.

The harness should let each test reset DOM + stubs cleanly between cases.

---

## Test 1 — Send/stop button toggles back after SSE terminal transition

### Bug

`applyTerminal()` removed the `.running` class from the assistant bubble
but never refreshed the button state. The stop button stayed visible
forever after the assistant finished.

### Fix

Added `syncProcessingButtons()` call at the end of `applyTerminal()`
([public/app.js:135](../public/app.js#L135)).

### Test setup

1. Bootstrap harness with the minimal DOM.
2. Set `currentConversationId` to a known value (either by going through
   `sendMessage()` with a stubbed `fetch` that returns a conversationId,
   or by directly inserting a running assistant bubble into the DOM with
   a known `data-message-id`).
3. End state for setup: a `.message.assistant.running` bubble exists in
   `#messages`, send button is hidden, stop button is visible.

### Action

Simulate an SSE `message_transition` event for that messageId — either
by calling the captured `EventSource.onmessage` directly with a synthetic
`MessageEvent`, or by exposing `applyTerminal` and calling it.

```
{
  type: "message_transition",
  messageId: "<the running bubble's id>",
  status: "complete",
  content: "ok"
}
```

### Assertions

- The bubble no longer has the `running` class; has `complete` instead.
- `sendBtn.style.display === "flex"` (or whatever non-`none` value).
- `stopBtn.style.display === "none"`.
- `sendBtn.disabled === false`.

### Negative case worth covering

Call `applyTerminal` for a messageId that doesn't exist in the DOM.
Buttons should be unchanged from their pre-call state (the function
short-circuits on `!bubble`).

---

## Test 2 — Visibility resume re-syncs conversation state

### Bug

If the page was backgrounded long enough for the browser to suspend the
tab and tear down the SSE connection, any `message_transition` fired
during the gap was dropped by the in-memory SSE emitter. On resume there
was no re-fetch path, so the bubble stayed stuck on "Thinking…".

### Fix

Added a `visibilitychange` listener that calls `syncConversationState()`
when the page becomes visible *and* a running assistant bubble exists
([public/app.js:418-428](../public/app.js#L418-L428)).

### Test setup

1. Bootstrap harness with the minimal DOM.
2. Set `currentConversationId` to a known value.
3. Insert a running assistant bubble into `#messages`.
4. Reset the `fetch` stub's call log so we can assert cleanly on the
   resync calls.

### Action

Set `document.visibilityState` to `"visible"` and dispatch a
`visibilitychange` event:

```js
Object.defineProperty(document, "visibilityState", {
  value: "visible",
  configurable: true,
});
document.dispatchEvent(new Event("visibilitychange"));
```

### Assertions

- `fetch` was called with `/api/conversations/<id>/messages`.
- `fetch` was called with `/api/conversations/<id>/tools`.
- (These are the two pulls inside `syncConversationState()`.)

### Negative cases worth covering

Each should result in **zero** fetch calls — the handler short-circuits:

1. `visibilityState === "hidden"` (event fires on backgrounding too) —
   no fetches.
2. `currentConversationId === null` — no fetches even if visible.
3. No running bubble in the DOM — no fetches even if visible with a
   conversation id.

---

## Notes for whoever writes these

- Both tests live entirely in jsdom — no Postgres, no real network,
  no SSE server. Keep them fast and isolated from the existing
  Postgres-backed test suite.
- The existing test runner is `node --test`. jsdom plays fine with it;
  no Vitest/Jest needed.
- `app.js` attaches listeners at module load. If the harness loads it
  more than once per test process, you'll get duplicate listeners —
  either reset the jsdom window between tests, or load `app.js` once
  and reset DOM + stub state between cases.
