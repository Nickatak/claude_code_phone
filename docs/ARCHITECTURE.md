# Pocket Claude v2 - Architecture

## Problem

Claude Code's harness (tools, file access, system prompts, memory) is what makes it
better than claude.ai - not the model. claude.ai doesn't let you use your own harness.
This project pipes prompts from a phone directly into Claude Code, leveraging the
existing Claude Max subscription instead of paying for API access.

## Constraints

- No API costs - uses Claude Code SDK against Max subscription
- Single user (Nick), no multi-tenancy
- All devices on Tailscale - networking is solved
- PC must be on to use the service (no remote wake, no cloud fallback)

## Architecture

Two Proxmox VMs on a private lab subnet (`10.20.0.0/24`):

- **dock01** (`10.20.0.110`) — runs the app container. Single Docker host.
- **pg01** (`10.20.0.120`) — runs Postgres 17. Lab-subnet only, no public exposure.

```
Phone (browser, PWA)
  |  HTTPS over Tailscale
  v
dock01: app container (serves UI + manages SDK child processes)
  |  spawns                     |  Postgres connection
  v                             v
Claude Code SDK              pg01: Postgres 17
(child process, host fs       (pocket_claude DB,
 via volume mounts)            owned by pocket_claude_app role)
```

There is no relay. There is no separate worker. dock01 serves the frontend,
handles requests, runs the SDK, and persists state to pg01. Both VMs are
restart-resilient (`unless-stopped` for the container, systemd for Postgres).

### Why not a relay?

v1 used a Pixel 3a as an always-on relay between the phone and PC. The reasoning
was that the phone needed a stable endpoint to connect to. But:

- The PC has to be on anyway to run the SDK
- All devices are already on Tailscale (stable IPs, direct connectivity)
- The relay added a WebSocket protocol, auth layer, and message routing that
  only existed because of the two-machine split
- No value in showing "PC offline" on a relay when the alternative is just
  a browser connection error (same information)

The Pixel solved a networking problem that Tailscale already solves.

## Protocol

Not token-streaming. The v1 approach of streaming every text delta to the phone
caused constant scroll reflow on a small screen and was actively unpleasant to use.

### Durable execution

SDK calls are durable - the server owns execution from the moment it accepts a prompt.
The client does not need to stay connected. Results are written to the database as they
happen, not when they're delivered to a client.

- If the client is connected: it sees tool events and the response in real time
- If the client disconnects mid-execution: the SDK keeps running, result lands in DB
- When the client reconnects: it fetches whatever it missed via REST

The client can also hard-stop a running prompt. This kills the SDK child process
and writes whatever partial state exists (completed tool calls, any generated text)
to the DB as a terminated message.

### Request flow

1. `POST /conversations/:id/messages` - send prompt, server accepts and returns message ID
2. Server spawns SDK child process, execution begins
3. **While processing (client connected):** SSE stream pushes tool activity events
   - Tool name, target/arguments summary, status (running/complete)
   - These render as cards in the UI, similar to Claude Code's VS Code extension
4. **On completion:** server writes full response to DB, pushes it via SSE
5. Phone renders the complete response once - no reflow, no scroll jank
6. **On reconnect (client was away):** `GET /conversations/:id/messages` catches up

### Stop command

`POST /conversations/:id/stop` - kills the active SDK child process for this
conversation. Server writes partial results to DB. Client sees what completed
before the kill.

### What streams vs what doesn't

| Event type     | Delivery        | Why                                    |
|----------------|-----------------|----------------------------------------|
| Tool calls     | SSE push        | Liveness signal, shows what's happening|
| Final response | SSE push + DB   | No partial rendering, no scroll resets |
| Errors         | SSE push        | User needs to know right away          |
| Stop           | REST POST       | Client -> server, one-shot command     |
| Catch-up       | REST GET        | Client missed events, fetch from DB    |

### Transport

**SSE (Server-Sent Events)** for real-time server-to-client push. SSE is just an HTTP
response that doesn't close - the server holds the connection open and pushes lines of
text as events happen. The browser has a built-in `EventSource` API for it (no library).

SSE is one-directional (server to client), which is all we need for monitoring execution.
The two client-to-server actions (send prompt, stop execution) are plain REST endpoints.

```
Client                              Server
  |                                   |
  |--- POST /messages (prompt) ------>|  (accepts, starts SDK)
  |                                   |
  |--- GET /events (SSE) ------------>|  (connection stays open)
  |<--- event: tool_call -------------|
  |<--- event: tool_call -------------|
  |<--- event: complete --------------|  (full response)
  |                                   |
  (if client disconnects, server keeps running - result lands in DB)
  (if client reconnects, GET /messages catches up)
```

**Why not WebSocket?** WebSocket is bidirectional, which we don't need. The v1 relay
required bidirectional communication between two servers. This is simpler: the client
sends commands via POST, watches results via SSE, and catches up via GET. Three
standard HTTP patterns instead of a stateful protocol.

## Container Strategy

`docker-compose.yml` is the prod stack on dock01: just the app, talking to
external pg01 via `DATABASE_URL` in `.env`.

`docker-compose.dev.yml` is dev-only infrastructure: a local Postgres 17
container for iteration. The two files never merge - each is `up`/`down`
independently. Daily dev loop is `make db-up` then `make dev` (tsx watch
on the host, connecting to the local dev DB).

### Why Docker?

- `restart: unless-stopped` means the service survives reboots and crashes
- The Dockerfile copies `dist/` (built TypeScript) and `drizzle/` (migration
  files) so the container is self-contained at runtime
- No manual process management, no systemd unit files for the app

### Volume mounts

The SDK needs broad filesystem access (project files, `~/.claude`, git repos).
The relevant project directories and `~/.claude` are bind-mounted in. This is
the same attack surface as running Claude Code directly on the host with
bypass permissions - the container boundary doesn't change the surface.

### Image requirements

- Node.js (SDK runtime, currently `node:24-slim`)
- Git, curl, jq, ripgrep (SDK shells out to these)
- Claude Code CLI (`@anthropic-ai/claude-code`, installed globally)
- App's `node_modules` from `npm install --omit=dev`
- `drizzle/` migration files (so migrate-at-startup finds them)

## UI

Mobile-first PWA. Phone is the primary (and probably only) client.

### Message rendering

- **User messages**: sent and displayed immediately
- **While processing**: spinner/animated "Thinking..." indicator
- **Tool calls**: appear as cards in real time
  - Tool name and target (e.g., "Read src/server.ts", "Bash: npm test")
  - Collapsible detail (input/output)
  - Status indicator (running/complete)
- **Assistant response**: renders once, complete, when the SDK finishes
- **No token streaming**: the response is never partially displayed

### PWA

- `manifest.json` for add-to-home-screen
- Service worker for offline shell (show "PC offline" from cache, not browser error)
- Mobile viewport, touch-friendly controls

## Data Model

Three tables in Postgres on pg01:

- **conversations**: `id` (uuid), `title`, `session_id`, `cwd`, `status`
  (`idle | running | stopped | error`), `created_at`, `updated_at`
- **messages**: `id` (uuid), `conversation_id` (FK), `role`
  (`user | assistant`), `content`, `created_at`
- **tool_events**: `id` (serial), `conversation_id` (FK), `message_id` (FK,
  nullable), `tool_name`, `tool_id`, `input`, `status`
  (`running | complete | error`), `created_at`

SDK session resumption is the `conversations.session_id` column - the SDK
returns a session ID on its first run, we store it, and pass it as `resume`
on subsequent calls in the same conversation.

### Migrations

Drizzle ORM schema in `src/db/schema.ts`. SQL migrations live in `drizzle/`
and are generated with `make db-generate` (which runs `drizzle-kit generate`).
Migrations are applied at server startup via
`drizzle-orm/node-postgres/migrator` - no separate migration step in
deployment. Fail-on-startup is the right semantics for a single-instance
service: if migrations don't apply, refusing to serve traffic is correct.

### Why Postgres on a separate VM

- Storage isolation: dock01 has limited disk; pg01's data volume is sized
  for unbounded conversation growth
- Engine choice: SQLite worked at v1 scale but lacks proper concurrent
  writers, network access, and online backup tooling
- Lab pattern: pg01 is meant to back multiple lab services over time -
  this is the first

### Connection model

Single connection pool (`pg.Pool`) per app process. The pool is lazy - the
first query opens a TCP connection. Process shutdown should `pool.end()`
to drain in-flight work; not yet wired.

`pg_hba.conf` on pg01 has a per-app rule:
`host pocket_claude pocket_claude_app 10.20.0.110/32 scram-sha-256` -
only dock01 can connect to this DB as this role. Adding new apps means
adding new rules, not relaxing existing ones.

## Auth

None. Single user on a private Tailscale network. The Tailscale ACL is the auth layer.
If this ever needs to change, token auth can be added at the HTTP layer.

## SDK Integration

The server spawns the Claude Code SDK as a child process per prompt. The process
runs inside the container with full access to the host filesystem via the ~ volume
mount. This is the same permission model as running Claude Code directly on WSL
with `permissionMode: bypassPermissions` - the container boundary doesn't change
the attack surface.

### Child process lifecycle

- **Spawn**: one child process per active prompt
- **Monitor**: server tracks the process, collects tool events and final output
- **Kill**: stop command terminates the process (SIGTERM, then SIGKILL if needed)
- **Write**: results written to DB as they happen, not on delivery to client

### SDK configuration

- `permissionMode: bypassPermissions` (same as local YOLO mode)
- `abortController` passed to SDK for clean stop command support
- Session resumption via SDK session IDs stored in DB
- Conversation history fed as context for new sessions
- Working directory set per conversation, changeable on resume

### CLAUDE.md handling

The global `~/.claude/CLAUDE.md` has a delivery rule ("write substantial output
to disk") that doesn't work from a phone. Instead of loading the global config:

- `settingSources: ["project"]` - skips global user CLAUDE.md
- `systemPrompt.append` injects `config/CLAUDE.md` (phone-specific version)
- Project-level CLAUDE.md files still load normally per working directory

The phone CLAUDE.md is identical to the global except for the delivery rule:
```
- delivery: "substantial output to disk as stable artifacts..."
+ delivery: "all output in chat; do not write files as artifacts"
```

Run `make sync-claude` to re-sync from the global after editing `~/.claude/CLAUDE.md`.
This copies the global, patches the delivery rule, and writes to `config/CLAUDE.md`.

## Scope

### MVP

Everything above. A working single-server setup where you open the PWA on your
phone, send a message, see tool activity in real time, and get complete responses.

### Deferred

- Multi-user / device isolation
- Remote PC wake
- Cloud fallback when PC is offline
- Conversation search
- File/image attachments in prompts
