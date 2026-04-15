# Remote Claude

Mobile interface for Claude Code. Pipes prompts from your phone into the Claude Code
SDK over Tailscale, using your existing Claude Max subscription.

## Why

Claude Code's harness (tools, file access, memory, system prompts) is what makes it
better than claude.ai - not the model. claude.ai doesn't let you use your own harness.
This gives you the full Claude Code experience from a phone.

## Architecture

Single server running on WSL inside Docker. Phone connects directly over Tailscale.
No relay, no separate worker, no middleman.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Quick start

```bash
# Development
npm install
make dev

# Production (Docker)
make build
make start
```

## Standards

See [CONTRIBUTING.md](CONTRIBUTING.md).
