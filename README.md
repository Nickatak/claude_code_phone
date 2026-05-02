# Pocket Claude

Mobile-first interface for Claude Code agents that runs the full Claude Code SDK
from your phone over Tailscale. This provides the benefits of being able to use your existing CLAUDE.md config as well as your existing Claude Max subscription so there's no additional API costs.

## What it does

- Spawns and manages Claude Code SDK agent sessions from a phone
- Durable execution - the server owns the agent from prompt to completion.
  Disconnect mid-run, reconnect later, pick up where it left off.
- Real-time tool activity via SSE - tool cards show what the agent is doing
  (file reads, bash commands, searches) as it works
- Conversation persistence with session resumption across prompts
- Phone-specific CLAUDE.md injection - patches your global config for the
  mobile/container context (delivery rules, networking, share link handling)
- Stop/abort running agents on demand

## Why not claude.ai?

Claude.AI has no persistent memory (it has a summarized list of about 30 things long or so, but no actual "hard memory").  Claude Code has a global config, as well as project-specific memory that can be applied to each prompt.  Both of these things together make it vastly more configurable and significantly more performant if your config is accurate.

## Architecture

Single Express server running on WSL inside Docker. Your phone connects directly over Tailscale, so no auth needed.

- SQLite (drizzle) for conversations, messages, and tool events
- SSE for server-to-client push, REST for commands
- PWA frontend with offline shell

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Prerequisites

- Linux or WSL2 (if on Windows)
- Docker
- Tailscale (or any VPN/tunnel that gives your phone a route to the host)
- Claude Max subscription with Claude Code installed

This was built for WSL2 + Docker Desktop on Windows. Native Linux works the same
way. There are a few paths hardcoded to the author's home directory (`/home/nick`)
in `docker-compose.yml`, `src/sdk/process-manager.ts`, and `public/app.js` - swap
them for yours.

## Usage

```bash
# First time - sync phone CLAUDE.md from your global
make sync-claude

# Build and start (Docker)
make docker-up

# Rebuild after changes
make docker-rebuild

# Development (hot reload, no Docker)
npm install
make dev
```

Run `make help` for all commands.

## Standards

See [CONTRIBUTING.md](CONTRIBUTING.md).
