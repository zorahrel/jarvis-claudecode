#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Jarvis-local: write the flat registry where the dashboard reads it.
export MCP_GATEWAY_REGISTRY="${MCP_GATEWAY_REGISTRY:-$DIR/../../state/mcp-gateway-tools.json}"
exec node "$DIR/index.mjs"
