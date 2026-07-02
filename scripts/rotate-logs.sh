#!/bin/bash
# Jarvis log rotation — inode-safe truncate of unbounded launchd stdout logs.
# Keeps the last KEEP lines of any log over THRESHOLD bytes. No sudo, no deps.
# The cat-from-tail preserves the inode so the live process keeps appending.
set -euo pipefail
LOGDIR="$HOME/.claude/jarvis/logs"
THRESHOLD=$((50 * 1024 * 1024)) # 50 MB
KEEP=50000                      # lines retained per file

for f in router.log topics-server.log topics-server-error.log; do
  p="$LOGDIR/$f"
  [ -f "$p" ] || continue
  sz=$(stat -f%z "$p" 2>/dev/null || echo 0)
  [ "$sz" -gt "$THRESHOLD" ] || continue
  t=$(mktemp "${TMPDIR:-/tmp}/jlogrot.XXXXXX")
  tail -n "$KEEP" "$p" >"$t" && cat "$t" >"$p"
  rm -f "$t"
done
