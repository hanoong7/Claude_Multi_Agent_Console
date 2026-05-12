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

PROD=1 PORT=${PORT:-8787} node app.js
