# Pocket Claude

Mobile-first interface for Claude Code that pipes prompts from your phone into
the Claude Code SDK over Tailscale. Uses your existing Claude Max subscription
(no API costs) and your CLAUDE.md config, so your phone gets the same Claude
harness your terminal does.

## What it does

- Spawns and manages Claude Code SDK agent sessions from a phone
- Durable execution: the server owns the agent from prompt to terminal.
  Disconnect mid-run, reconnect later, the result lands in the DB and the
  phone catches up via REST.
- Real-time tool activity via SSE - tool cards show what the agent is doing
  (file reads, bash commands, searches) as it works
- Per-message FSM (running → complete | stopped | error) - no partial-text
  rendering, no race-prone in-flight state
- Conversation persistence with SDK session resumption across prompts
- Phone-tuned system prompt - `make sync-claude` pulls your Claude Code
  output style (`~/.claude/output-styles/personal.md`), patches container
  bits (passthrough host, etc.), appends mobile overrides from
  `config/phone-additions.md`, and the result rides every SDK call as
  `systemPrompt.append`. Your behavior contract carries over from desktop;
  fields whose value depends on you being at a keyboard get re-specified.
- Stop/abort running agents on demand

## Why not claude.ai?

Claude.ai has no persistent memory across conversations - just an abbreviated
profile of ~30 facts. Claude Code has a global `CLAUDE.md` and project-level
memory that loads into every prompt. That's vastly more configurable and
significantly more performant once your config is dialed in - and Pocket Claude
lets you keep using it from your phone without paying for API access.

## Architecture

Two-VM split:

- **app host** (`dock01`) - serves the PWA, runs the Claude Code SDK as child
  processes, talks to Postgres
- **DB host** (`pg01`) - Postgres 17, lab-subnet only

Phone connects to the app host directly over Tailscale, so no auth.

- Postgres (drizzle ORM, migrations applied at startup)
- SSE for server→client push, REST for commands and reconnect catch-up
- Vanilla PWA frontend, no framework

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

## Prerequisites

- Linux host (any distribution; the author's `dock01` runs Debian 13)
- Docker + docker compose
- A Postgres 17 instance reachable from the app host. For development,
  `docker-compose.dev.yml` brings up a local one.
- Tailscale (or any VPN that gives your phone a route to the app host)
- Claude Max subscription with Claude Code CLI authenticated on the host
  (`claude auth login`)

This is the author's setup. Paths are hardcoded to `/home/nick` and the lab
subnet `10.20.0.0/24` - swap them in `docker-compose.yml`, `.env`, and your
Postgres host's `pg_hba.conf`. The app itself only cares about `DATABASE_URL`.

## Usage

### Local development

```bash
# One time: bring up a local Postgres (persists in a named volume)
make db-up

# Rebuild the phone system prompt from your output style + mobile overrides
# (re-run after editing ~/.claude/output-styles/personal.md or config/phone-additions.md)
make sync-claude

# Run the dev server with hot reload, pointed at the local dev DB
npm install
make dev
```

Local `.env` needs `DATABASE_URL` pointed at the dev DB - see
`docker-compose.dev.yml` for the credentials and port.

### Database changes

When you edit `src/db/schema.ts`:

```bash
make db-generate    # generates a new SQL migration in drizzle/
```

Migrations apply automatically at server startup - no separate migrate step in
the deploy.

### Production deploy

```bash
make docker-up       # build image, start container (hits the external DB via DATABASE_URL)
make docker-logs
make docker-rebuild  # force rebuild image and restart
```

`.env` on the deploy host carries the prod `DATABASE_URL` and is loaded via
`env_file:` in `docker-compose.yml`, so secrets stay out of git.

Run `make help` for all commands.

## Standards

See [CONTRIBUTING.md](CONTRIBUTING.md).
