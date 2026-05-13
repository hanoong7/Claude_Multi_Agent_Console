#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (v20+). Install from https://nodejs.org and retry."
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $NODE_MAJOR detected; v20+ required. Upgrade and retry."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found in PATH."
  echo "Install: https://claude.com/code"
  echo "(After install, run 'claude' once to log in.)"
fi

# Clean up any leftover process holding the port from a previous run.
# Without this, a quick relaunch can race with the OS releasing the socket
# and the new node process dies with EADDRINUSE.
PORT_TO_USE=${PORT:-8787}
if command -v fuser >/dev/null 2>&1; then
  fuser -k ${PORT_TO_USE}/tcp >/dev/null 2>&1 || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti tcp:${PORT_TO_USE} 2>/dev/null || true)
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
fi
# tiny wait so the kernel releases the port
sleep 0.5

PROD=1 PORT=${PORT_TO_USE} exec node app.js
