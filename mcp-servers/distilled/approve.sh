#!/bin/zsh
# Promote a draft distillate to live: security scan → move → remount reminder.
# Usage: approve.sh <name> [--force]   (--force skips a failed skillspector scan)
set -euo pipefail

NAME="${1:-}"
FORCE="${2:-}"
BASE="$HOME/.claude/jarvis/distilled"
DRAFT="$BASE/_drafts/$NAME"

[[ -n "$NAME" ]] || { echo "usage: approve.sh <name> [--force]"; exit 1; }
[[ -d "$DRAFT" ]] || { echo "draft non trovato: $DRAFT"; exit 1; }
[[ ! -e "$BASE/$NAME" ]] || { echo "esiste già live: $BASE/$NAME"; exit 1; }
[[ -f "$DRAFT/manifest.json" && -x "$DRAFT/run" ]] || { echo "draft incompleto: servono manifest.json e run eseguibile"; exit 1; }

if command -v skillspector >/dev/null 2>&1; then
  echo "→ skillspector scan..."
  if ! skillspector scan "$DRAFT" --no-llm; then
    if [[ "$FORCE" == "--force" ]]; then
      echo "⚠️  scan fallita ma --force: procedo"
    else
      echo "❌ scan fallita. Rivedi il draft o ripeti con --force."
      exit 1
    fi
  fi
else
  echo "⚠️  skillspector non trovato, salto la scan"
fi

mv "$DRAFT" "$BASE/$NAME"
echo "✅ $NAME promosso a live: $BASE/$NAME"
echo "Per vederlo in sessione: rimonta il child → gateway_unmount {name:\"distilled\"} poi gateway_mount"
echo "(oppure: launchctl kickstart -k gui/\$(id -u)/com.jarvis.gateway)"
