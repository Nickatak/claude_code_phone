# Remote Claude — Mobile-Friendly Claude Code Interface

## Problem
Claude Code (CLI/VS Code extension) provides a significantly better experience than claude.ai because of tools, file access, system prompts, and memory. But Claude Code is painful to use from a phone.

## Key Insight
The quality difference between claude.ai and Claude Code isn't the model — it's the harness. Same brain, different tools. This project replicates the harness with a phone-friendly frontend.

## Constraints
- **No API costs.** Nick already pays for Claude Max. The system must use Claude Code (via the SDK), not the Claude API directly.
- **No manual server startup.** Nick's main PC (WSL) should auto-register when WSL starts. Using the phone should require zero interaction with the PC.
- **Isolated from other infra.** The always-on box is a dedicated device, not Nick's VPS (which hosts other things and has its own orchestration).

## Architecture

Three components, two machines, connected via Tailscale.

```
Phone (browser)
  |  HTTP over Tailscale
  v
Pixel 3a  (relay + frontend, always-on)
  |  WebSocket (Tailscale or LAN)
  v
Main PC / WSL  (Claude Code executor)
```

### 1. Pixel 3a — Relay Server
A repurposed Pixel 3a running Termux + Node.js, plugged in 24/7 via USB-C hub (Ethernet + power passthrough). The phone's entry point.

**Responsibilities:**
- Serve the mobile-friendly chat UI (static frontend)
- Persistently store conversation history (SQLite) — used both to resume past conversations in the UI and to feed prior context into new Claude Code sessions after crashes/reboots
- Accept WebSocket connections from the main PC (worker registration)
- Relay messages between the phone and the main PC
- Expose PC online/offline status to the frontend
- Token-based auth (simple bearer token or password — just enough to prevent unauthorized use on the tailnet)

**Does NOT:**
- Run Claude Code
- Call the Claude API
- Have any knowledge of tools, files, or project context

### 2. Main PC (WSL) — Claude Code Worker
A lightweight Node/TypeScript client that runs on Nick's development machine.

**Responsibilities:**
- On WSL startup, automatically connect to the relay server via WebSocket
- Receive message requests from the relay
- Run Claude Code SDK sessions
- Stream results (text, tool use, tool results) back to the relay
- Reconnect automatically if the connection drops

**Auto-registration:** A script in WSL's startup (`.bashrc`, systemd user service, or similar) that connects to the relay. Hands-free — no manual intervention.

### 3. Phone — Mobile Chat UI
A mobile-first web frontend served by the relay.

**Responsibilities:**
- Chat interface optimized for phone keyboards and small screens
- Display current conversation messages, tool use activity (file edits, command output), and status
- When online: show past conversations, allow resuming them
- When offline: dead screen with "offline" status notice, nothing else
- Connect to the relay via WebSocket or SSE for streaming responses

### Networking
- All three devices (phone, Pixel 3a, main PC) are on the same Tailscale network
- Pixel 3a connected via Ethernet (USB-C hub with power passthrough) for stability
- Phone accesses the relay at its Tailscale IP (e.g., `http://100.x.x.x:3000`)
- Main PC connects out to the relay — no port forwarding, no inbound connections needed
- No external tunnel brokers (no ngrok, no Cloudflare Tunnel)

## Tech Stack
- **Language:** TypeScript (both relay and worker)
- **Relay runtime:** Termux on Android (Pixel 3a) → Node.js (Express) + WebSocket (ws)
- **Storage:** SQLite (conversation history on the Pixel 3a)
- **Worker:** Node.js + Claude Code SDK (`@anthropic-ai/claude-code`)
- **Frontend:** Minimal — vanilla or lightweight framework, mobile-first CSS
- **Networking:** Tailscale

## Message Flow

### Happy path (PC online):
1. Nick opens chat on phone, types a message
2. Phone sends message to relay over HTTP/WebSocket
3. Relay stores the message, forwards it to the main PC via WebSocket
4. Main PC runs Claude Code SDK with the message (+ conversation history)
5. Claude Code streams responses (text chunks, tool calls, tool results)
6. Main PC streams events back to relay
7. Relay stores the response, streams it to the phone UI
8. Phone renders the response incrementally

### PC offline:
1. Nick opens chat on phone
2. UI shows "PC offline" — nothing else. No history browsing, no UI beyond the status
3. Sending new messages is blocked until the PC reconnects

### Resuming after crash/reboot:
1. PC comes back online, worker auto-reconnects to relay
2. Nick opens a past conversation in the UI
3. Relay feeds stored history into a new Claude Code SDK session
4. Conversation continues with full prior context
