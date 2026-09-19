#!/bin/bash
# Aggiorna OpenClaw fuori dal servizio gateway.
#
# Perche' esiste: il LaunchAgent del gateway gira con Umask 077, e l'updater di
# OpenClaw (<=2026.9.5) confronta il mode del symlink /opt/homebrew/bin/openclaw
# con quello della copia di backup. Sotto 077 la copia nasce 0700 invece di 0755
# e lo swap aborta con "Package rollback launcher backup changed", lasciando
# l'installazione ferma alla versione vecchia. Qui forziamo 022 sul solo update.
#
# Seconda trappola: la validazione del candidato ha un tetto fisso di 300s che
# copre doctor + lint + canary. A macchina carica lo sfora e l'update fallisce
# con "Candidate doctor failed". Per questo aspettiamo che il load scenda.
set -uo pipefail

umask 022
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOG=~/Library/Logs/jarvis-openclaw-update.log
MAX_LOAD=${MAX_LOAD:-5}
WAIT_SLICES=${WAIT_SLICES:-60}   # 60 x 60s = fino a 1h di attesa

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

command -v openclaw >/dev/null || { log "openclaw non trovato nel PATH"; exit 1; }

BEFORE=$(openclaw --version 2>/dev/null | head -1)
if openclaw update status 2>/dev/null | grep -q "up to date"; then
  log "gia' aggiornato: $BEFORE"
  exit 0
fi

# Aspetta una finestra tranquilla, altrimenti il deadline di 300s salta.
for _ in $(seq 1 "$WAIT_SLICES"); do
  LOAD=$(uptime | sed 's/.*load averages*: //' | awk '{print $1}' | tr -d ,)
  awk -v l="$LOAD" -v m="$MAX_LOAD" 'BEGIN{exit !(l<m)}' && break
  sleep 60
done
log "load=$LOAD, avvio update da $BEFORE"

openclaw update --yes >> "$LOG" 2>&1
AFTER=$(openclaw --version 2>/dev/null | head -1)

if [ "$BEFORE" = "$AFTER" ]; then
  log "FALLITO: ancora $AFTER"
  exit 1
fi
log "OK: $BEFORE -> $AFTER"
