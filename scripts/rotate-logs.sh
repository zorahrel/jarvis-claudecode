#!/bin/bash
# Jarvis log rotation — inode-safe truncate of unbounded launchd stdout logs.
# Keeps the last KEEP lines of any log over THRESHOLD bytes. No sudo, no deps.
# The cat-from-tail preserves the inode so the live process keeps appending.
set -euo pipefail
LOGDIR="$HOME/.claude/jarvis/logs"
THRESHOLD=$((50 * 1024 * 1024)) # 50 MB
KEEP=50000                      # lines retained per file

for f in router.log topics-server.log topics-server-error.log vdm.log; do
  p="$LOGDIR/$f"
  [ -f "$p" ] || continue
  sz=$(stat -f%z "$p" 2>/dev/null || echo 0)
  [ "$sz" -gt "$THRESHOLD" ] || continue
  t=$(mktemp "${TMPDIR:-/tmp}/jlogrot.XXXXXX")
  tail -n "$KEEP" "$p" >"$t" && cat "$t" >"$p"
  rm -f "$t"
done

# Eventi del monitor sessioni: nessuno li cancellava, e crescevano da giugno
# (60.000 file, 230 MB) senza limite. Sono record effimeri già consumati:
# oltre EVENT_DAYS non servono più a nessuno.
# Qui `rm` e non `trash`: questo gira ogni notte, e mandare decine di migliaia
# di file al Cestino lo farebbe crescere al posto della cartella.
EVENTDIR="$HOME/.claude/jarvis/events"
EVENT_DAYS=30
if [ -d "$EVENTDIR" ]; then
  find "$EVENTDIR" -maxdepth 1 -type f -name '*.json' -mtime +"$EVENT_DAYS" -delete 2>/dev/null || true
fi
