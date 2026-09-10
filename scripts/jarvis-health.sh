#!/usr/bin/env bash
#
# jarvis-health.sh — probe dello stato di Jarvis, con exit code.
#
# Perche' esiste: i check vivevano come bash sparso dentro il prompt di
# morning-check. Se un probe si rompeva non falliva un processo, falliva la
# frase che il modello scriveva — e infatti il 07/08/2026 l'audit ha trovato
# tre check bugiardi, tra cui uno (Docker) che non poteva fallire per
# costruzione: `2>/dev/null` mangiava l'errore, l'output vuoto passava, e il
# template stampava "Docker: OK" su un daemon inesistente.
#
# Regola di questo file: ogni probe distingue quattro stati e nessuno di essi
# e' il silenzio.
#   OK    verde
#   WARN  degradato ma non guasto        -> non cambia l'exit code
#   FAIL  guasto                         -> exit 1
#   SKIP  assente per scelta, non rotto  -> non cambia l'exit code
#
# Uso:
#   jarvis-health.sh            report leggibile, exit 0/1
#   jarvis-health.sh --quiet    stampa solo WARN/FAIL
#
set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

FAILS=0
WARNS=0

# --- reporter ---------------------------------------------------------------
ok()   { (( QUIET )) || printf '  OK    %-14s %s\n' "$1" "${2:-}"; }
warn() { WARNS=$((WARNS+1)); printf '  WARN  %-14s %s\n' "$1" "${2:-}"; }
fail() { FAILS=$((FAILS+1)); printf '  FAIL  %-14s %s\n' "$1" "${2:-}"; }
skip() { (( QUIET )) || printf '  SKIP  %-14s %s\n' "$1" "${2:-}"; }
section() { (( QUIET )) || printf '\n%s\n' "$1"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER=http://127.0.0.1:3340
WA_AUTH="$HOME/.claude/jarvis/router/wa-auth"

# --- disco ------------------------------------------------------------------
section "Disco"
avail_gb=$(df -g / | awk 'NR==2 {print $4}')
if [[ -z "$avail_gb" ]]; then
  fail disco "df non ha restituito nulla"
elif (( avail_gb < 20 )); then
  fail disco "${avail_gb}G liberi (soglia 20G)"
elif (( avail_gb < 50 )); then
  warn disco "${avail_gb}G liberi (soglia 50G)"
else
  ok disco "${avail_gb}G liberi"
fi

# --- docker -----------------------------------------------------------------
# Tre esiti distinti. "Non installato" e "daemon spento" NON sono guasti:
# Docker.app e' stato cestinato di proposito il 19/07/2026.
section "Docker"
if ! command -v docker >/dev/null 2>&1; then
  skip docker "non installato"
elif ! docker info >/dev/null 2>&1; then
  skip docker "installato ma daemon spento (atteso dal 19/07/2026)"
else
  reclaim=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)
  gb=$(printf '%s' "${reclaim:-0}" | grep -oE '^[0-9.]+' || echo 0)
  if awk "BEGIN{exit !(${gb:-0} > 5)}"; then
    warn docker "${reclaim} recuperabili — docker image prune -a --filter 'until=720h' -f"
  else
    ok docker "${reclaim:-0} recuperabili"
  fi
fi

# --- cache dev --------------------------------------------------------------
section "Cache"
check_cache() { # nome, path, soglia MB
  [[ -d "$2" ]] || { skip "$1" "assente"; return; }
  local mb; mb=$(du -sm "$2" 2>/dev/null | awk '{print $1}')
  if [[ -n "$mb" ]] && (( mb > $3 )); then
    warn "$1" "${mb}MB (soglia ${3}MB)"
  else
    ok "$1" "${mb:-0}MB"
  fi
}
check_cache npm  "$HOME/.npm/_cacache"        500
check_cache bun  "$HOME/.bun/install/cache"   500
check_cache brew "$(brew --cache 2>/dev/null || echo /nonexistent)" 200

# --- servizi ----------------------------------------------------------------
# :3342 e' docs-index (docs-server.py, sqlite+numpy). NON e' piu' ChromaDB dal
# 05/07/2026 e non risponde su /api/v2/heartbeat — il vecchio probe stampava
# un rosso falso ogni mattina da un mese.
section "Servizi"
probe() { # nome, url
  if curl -sf --max-time 5 "$2" >/dev/null 2>&1; then ok "$1" "$2"; else fail "$1" "non risponde su $2"; fi
}
probe router     "$ROUTER/api/services"
probe docs-index "http://127.0.0.1:3342/health"
probe omega      "http://127.0.0.1:3343/health"

# --- cron -------------------------------------------------------------------
# Il vecchio check guardava solo consecutiveErrors>2: un cron che smette di
# partire ha errori a zero e lastRun vecchio, quindi era invisibile. Qui la
# staleness si misura contro il periodo dedotto dallo schedule.
section "Cron"
cron_out=$(curl -sf --max-time 5 "$ROUTER/api/crons" 2>/dev/null | python3 "$HERE/health/cron.py" 2>&1)

if [[ -z "$cron_out" ]]; then
  fail cron "il router non ha risposto su /api/crons"
else
  while IFS='|' read -r state name msg; do
    case "$state" in
      OK)   ok   "$name" "$msg" ;;
      WARN) warn "$name" "$msg" ;;
      FAIL) fail "$name" "$msg" ;;
      SKIP) skip "$name" "$msg" ;;
    esac
  done <<< "$cron_out"
fi

# --- whatsapp ---------------------------------------------------------------
# Ogni dispositivo companion online sopprime le push WhatsApp sul telefono, e
# Jarvis e' solo UNO dei companion. Il 07/08/2026 il colpevole era Beeper, non
# il router: senza questa riga ci sono voluti quaranta minuti per stabilirlo.
section "WhatsApp"
wa_status=$(curl -sf --max-time 5 "$ROUTER/api/whatsapp/status" 2>/dev/null)
if [[ -z "$wa_status" ]]; then
  fail whatsapp "il router non ha risposto su /api/whatsapp/status"
else
  wa_out=$(printf '%s' "$wa_status" | WA_AUTH="$WA_AUTH" python3 "$HERE/health/whatsapp.py" 2>&1)

  if [[ -z "$wa_out" ]]; then
    fail whatsapp "stato non parsabile"
  else
    while IFS='|' read -r state name msg; do
      case "$state" in
        OK)   ok   "$name" "$msg" ;;
        WARN) warn "$name" "$msg" ;;
        FAIL) fail "$name" "$msg" ;;
        SKIP) skip "$name" "$msg" ;;
      esac
    done <<< "$wa_out"
  fi
fi

# --- porte ------------------------------------------------------------------
# Elenca solo le porte NON attribuite. La lista sotto e' stata verificata il
# 07/08/2026 processo per processo; 8080 (bandi, spento dal 30/06) e 18789
# (gateway OpenClaw) sono state rimosse perche' silenziavano roba inesistente.
section "Porte"
KNOWN_PORTS=$(cat <<'EOF'
3333 topics-app server
3334 account-switcher
3335 account-switcher
3340 jarvis router http
3341 jarvis router https
3342 docs-index
3343 omega
3344 jarvis-browser
3355 claude-usage-tray
3737 darkroom backend
5199 vite dev
5432 postgres
5600 activitywatch
7842 sales-companion bridge
13333 topics tauri
19222 chrome cdp
19223 chrome cdp
23371 mcp gateway
23373 beeper
43726 omnara
50882 beeper
EOF
)
unknown=$(/usr/sbin/lsof -iTCP -sTCP:LISTEN -P 2>/dev/null \
  | awk 'NR>1 && ($1 ~ /^(node|bun|Python|python3)$/) {split($9,a,":"); print a[length(a)], $1}' \
  | sort -n -u \
  | while read -r port proc; do
      grep -qE "^${port} " <<< "$KNOWN_PORTS" || echo "$port ($proc)"
    done)
if [[ -z "$unknown" ]]; then
  ok porte "nessun listener node/bun/python sconosciuto"
else
  warn porte "listener non attribuiti: $(tr '\n' ' ' <<< "$unknown")"
fi

# --- esito ------------------------------------------------------------------
printf '\n'
if (( FAILS > 0 )); then
  (( FAILS == 1 )) && noun=guasto || noun=guasti
  printf '%d %s, %d warning\n' "$FAILS" "$noun" "$WARNS"
  exit 1
fi
printf 'tutto verde (%d warning)\n' "$WARNS"
exit 0
