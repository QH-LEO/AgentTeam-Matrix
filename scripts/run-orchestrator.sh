#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR/orchestrator"

if [ ! -d node_modules ]; then
  echo "Installing orchestrator dependencies..."
  npm install
fi

echo "Starting AgentFlow orchestrator on http://localhost:8787"
npm run dev
