#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The gateway itself is the mcp-hot-gateway package (source of truth:
# ~/Projects/mcp-hot-gateway, linked here by `npm install`). This directory
# holds only the Jarvis-local side: the child roster, its secrets, the launchd
# job, and introspect.mjs.
ENTRY="$DIR/node_modules/mcp-hot-gateway/index.mjs"
if [ ! -f "$ENTRY" ]; then
  echo "[mcp-gateway] missing $ENTRY — run: npm install --prefix $DIR" >&2
  exit 1
fi

# Load gitignored secrets (OAuth client info, bearer tokens) referenced as
# ${VAR} in gateway-config.json.
[ -f "$DIR/.env" ] && set -a && . "$DIR/.env" && set +a

# Both paths MUST be explicit: the package resolves its defaults relative to its
# own location, which is no longer this directory. Without these the gateway
# would boot with an empty child roster.
export MCP_GATEWAY_CONFIG="${MCP_GATEWAY_CONFIG:-$DIR/gateway-config.json}"
export MCP_GATEWAY_REGISTRY="${MCP_GATEWAY_REGISTRY:-$DIR/../../state/mcp-gateway-tools.json}"

exec node "$ENTRY"
