#!/usr/bin/env bash
# MCP entrypoint (registered in ~/.claude.json). Daemon auto-starts on first use.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/mcp.mjs"
