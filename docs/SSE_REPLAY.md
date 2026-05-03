# SSE replay / late-subscriber gap

## The gap

The SSE emitter at [src/sse/emitter.ts](../src/sse/emitter.ts) is in-memory
pub/sub. If no client is subscribed at the moment an event is emitted, the
event is silently dropped. There is no replay buffer, no event log, no
`Last-Event-ID` support.

Subscribers can be missing for several real reasons:

- Mobile PWA backgrounded long enough for the OS / browser to suspend the
  tab and tear down the EventSource.
- Network blip between client and server (cell handoff, VPN reconnect,
  laptop wake-from-sleep).
- Server restart mid-run (the SDK run survives because it's owned by the
  process; the SSE connection does not).
- Client navigates away and back.

When this happens, any `tool_start`, `tool_complete`, or `message_transition`
that fires during the gap is gone. The client is now out of sync with the
server's authoritative state in Postgres.

## Current mitigation

The client patches around the gap with full-state pulls:

- `syncConversationState()` re-fetches messages + tool events on POST,
  on conversation open, and on `visibilitychange` (when a running bubble
  exists). See [public/app.js](../public/app.js).
- The fetch hits two REST endpoints and re-renders the entire conversation.

This works for the "stuck Thinking… bubble" symptom because `messages` and
`tools` tables hold the terminal state. It does **not** preserve event
*ordering* or intermediate tool-card streaming during the gap - the UI
just snaps to the current truth.

## Why a deeper fix might be worth it

The full-resync approach has limits:

1. **Wasted bandwidth on long conversations.** Every visibility flip
   re-pulls the whole message list and tool list. Fine at 10 messages,
   wasteful at 200.
2. **Re-render flicker.** `messagesContainer.innerHTML = ""` followed by
   replay drops scroll position and any expanded tool cards.
3. **Lost mid-stream tool events.** If three tools fire during the gap,
   the client never sees them stream in - they appear all at once on
   resync. Fine for correctness, ugly for UX.
4. **Tool-input streaming.** If we ever stream tool inputs token-by-token
   (instead of emitting once on completion), missed deltas can't be
   reconstructed from the DB without storing every delta.

## Sketches of a deeper fix

These are options to evaluate when revisiting, not a chosen design.

### Option A — bounded in-memory ring buffer per conversation

Keep the last N events per conversation in memory. On (re)connect, the
client sends `Last-Event-ID` (native EventSource feature); the server
replays everything after that ID before going live.

- Pros: small change, no schema work, native EventSource semantics.
- Cons: events lost across server restarts, ring size is a guess,
  memory grows with active-conversation count.

### Option B — persist events to a table, replay from DB

Add an `sse_events` table keyed by `(conversation_id, sequence)`. Emitter
writes both to the table and to in-memory subscribers. On reconnect,
replay from DB by `Last-Event-ID`.

- Pros: survives server restart, durable ordering, easy to debug
  (you can `SELECT * FROM sse_events WHERE conversation_id = ?`).
- Cons: write amplification per SDK turn, retention policy needed
  (delete on conversation completion? TTL?), one more table to maintain.

### Option C — client polls a "since" endpoint

Skip SSE replay entirely. Client tracks the last event sequence it saw;
on reconnect/visibility-resume, it calls `GET /events?since=<seq>` to
catch up before re-subscribing live.

- Pros: simpler protocol than `Last-Event-ID`, easy to reason about.
- Cons: still needs an event store on the server (same as B), plus a
  REST endpoint - more surface area than just leaning on SSE.

### Option D — accept the gap, harden the resync

Keep the current model but make resync cheaper and less disruptive:
incremental message fetch (`?since=<msgId>`), preserve scroll/expanded
cards across resync, debounce visibilitychange resync.

- Pros: smallest change, no protocol/storage work.
- Cons: doesn't fix mid-stream tool event loss, still wasteful on long
  conversations.

## Decision criteria when revisiting

- How long do conversations get in practice? (drives whether full
  resync is actually wasteful)
- Do we care about preserving mid-stream tool-card streaming during a
  network blip, or is "snap to current state on resume" acceptable?
- Are server restarts during active runs common enough to require
  durable event storage?
- Is `Last-Event-ID` worth the protocol coupling vs. a plain REST
  catch-up endpoint?
