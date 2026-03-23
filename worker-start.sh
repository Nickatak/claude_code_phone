#!/bin/bash
# Watchdog supervisor for the worker process.
# Restarts automatically on crash, exit, or hang-induced timeout kill.
#
# Auto-start on WSL boot:
#   echo 'nohup ~/remote_claude/worker-start.sh > /tmp/rc-worker.log 2>&1 &' >> ~/.bashrc

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  npm install
fi

RESTART_DELAY=5

while true; do
  echo "[watchdog] Starting worker at $(date)"
  npx tsx src/worker.ts
  EXIT_CODE=$?
  echo "[watchdog] Worker exited with code $EXIT_CODE at $(date)"
  echo "[watchdog] Restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
