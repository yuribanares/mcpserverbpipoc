#!/usr/bin/env bash
# try-locally.sh — try the AWS version on your own machine first. No AWS
# account needed, nothing is created in the cloud.
#
# Starts the two pieces exactly the way they run on AWS:
#   • the mock bank on http://localhost:4100   (what Lightsail runs)
#   • the MCP server on http://localhost:8000/mcp (what AgentCore runs)
# then runs the end-to-end journey test against them.
#
#   ./scripts/try-locally.sh           → test, then stop both
#   ./scripts/try-locally.sh --keep    → test, then keep both running so you can
#                                        open the demo UI against them (see below)
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"
KEEP=false; [[ "${1:-}" == "--keep" ]] && KEEP=true

echo; echo "════ Try the AWS version locally ════"
[[ -d "$REPO_ROOT/node_modules" ]] || (cd "$REPO_ROOT" && npm install --no-audit --no-fund --loglevel=error)
[[ -d "$DEPLOY_DIR/node_modules" ]] || (cd "$DEPLOY_DIR" && npm install --no-audit --no-fund --loglevel=error)

cd "$DEPLOY_DIR"
PORT=4100 DEMO_ECHO_LOGS=true node src/mock-bank.js > /tmp/bpi-mock-bank.log 2>&1 & BANK=$!
PORT=8000 BPI_API_URL=http://localhost:4100 ECHO_LOGS=true node src/http-server.js > /tmp/bpi-mcp-server.log 2>&1 & MCP=$!
stop() { kill "$BANK" "$MCP" 2>/dev/null || true; }
$KEEP || trap stop EXIT

for _ in $(seq 1 40); do
  curl -sf localhost:4100/health >/dev/null && curl -sf localhost:8000/ping >/dev/null && break
  sleep 0.25
done

AWS_MCP_URL=http://localhost:8000/mcp AWS_BANK_URL=http://localhost:4100 node src/test-journey.js

if $KEEP; then
  echo "  Both are still running (logs: /tmp/bpi-mock-bank.log, /tmp/bpi-mcp-server.log)."
  echo "  Open the demo UI against them in another terminal:"
  echo "     MCP_MODE=aws AWS_MCP_URL=http://localhost:8000/mcp AWS_BANK_URL=http://localhost:4100 npm start"
  echo "  Stop them with:  kill $BANK $MCP"
fi
