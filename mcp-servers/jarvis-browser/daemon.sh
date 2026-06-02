#!/usr/bin/env bash
# Run the session-pool daemon in the foreground (for launchd or manual ops).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/daemon.mjs"
