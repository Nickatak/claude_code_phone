# Remote Claude v2 - Architecture

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

Single server running on WSL, containerized via Docker Desktop.

```
Phone (browser, PWA)
  |  HTTPS over Tailscale
  v
Docker on WSL (serves UI + manages SDK child processes)
  |  spawns
  v
Claude Code SDK (child process, access to ~ via volume mount)
```

There is no relay. There is no separate worker. The PC serves the frontend,
handles requests, and runs the SDK directly. Docker Desktop starts with Windows,
the container restarts unless stopped. The service is available whenever the PC is on.

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

Docker Desktop on Windows, container runs in WSL.

```yaml
# Conceptual - not final
services:
  remote-claude:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /home/nick:/home/nick
    environment:
      - HOME=/home/nick
```

### Why Docker?

- Docker Desktop starts with Windows
- `restart: unless-stopped` means the service survives WSL restarts, crashes, etc.
- No manual process management, no systemd, no startup scripts

### Volume mount

The SDK needs broad filesystem access (project files, ~/.claude, git repos, etc.).
The entire home directory is mounted. This is the same attack surface as running
Claude Code directly on WSL with bypass permissions - the mount doesn't introduce
new risk, it just makes existing risk visible.

### Image requirements

- Node.js (SDK runtime)
- Git (SDK needs it for repo operations)
- Common CLI tools the SDK shells out to
- Claude Code SDK (`@anthropic-ai/claude-code`)

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

Carried forward from v1, adjusted as needed.

- **Conversations**: id, title, created_at, last_active
- **Messages**: id, conversation_id, role (user/assistant), content, tool_use metadata, created_at
- **SDK Sessions**: conversation_id -> session_id mapping for resuming context

SQLite, same as v1. Single user, single machine, no need for anything heavier.

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
