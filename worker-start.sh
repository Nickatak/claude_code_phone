#!/bin/bash
# Auto-start worker on WSL boot.
# Add to ~/.bashrc or set up as a systemd user service:
#   echo 'nohup ~/remote_claude/worker-start.sh > /tmp/rc-worker.log 2>&1 &' >> ~/.bashrc

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  npm install
fi

# Run the worker (will auto-reconnect if relay is unavailable)
exec npx tsx src/worker.ts
