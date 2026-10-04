#!/bin/bash
# Lancia il brief mattutino (cron OpenClaw brief-mattutino): prompt su stdin, messaggio su stdout.
#
# Perche' un wrapper. Il 03/10 i 4 giri sono finiti tutti in «command timed out» dopo 900 s senza
# una riga di output: entrambi gli account Claude avevano la quota finita fino alle 13:00 e il proxy
# account-switcher (127.0.0.1:3336, usageCapHoldMin 1440) trattiene le richieste invece di
# rifiutarle, quindi `claude -p` riprovava in silenzio finche' OpenClaw lo uccideva.
# Qui: se la quota e' finita si salta Claude, se Claude non chiude entro CLAUDE_MAX si passa a
# codex, e se fallisce anche quello esce comunque un messaggio che dice il perche'.
set -u
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CLAUDE_MAX=${BRIEF_CLAUDE_MAX:-600}   # un giro normale dura 60-120 s
CODEX_MAX=${BRIEF_CODEX_MAX:-480}
BRIEF_FILE=${BRIEF_FILE:-$HOME/.openclaw/privato/brief-mattutino.md}  # override solo per le prove
ERRLOG="$HOME/.claude/jarvis/logs/openclaw-cron-claude.err.log"
SYSTEM="You are a subagent. Respond ONLY to the specific task. No preambles, no personal memory, no brand. Terse, bullet-form when natural, no decorative markdown unless asked."

work=$(mktemp -d /tmp/brief-mattutino.XXXXXX)
trap 'rm -rf "$work"' EXIT
cat > "$work/prompt"
touch "$work/start"

log() { echo "$(date '+%F %T') brief-mattutino: $*" >> "$ERRLOG"; }
# timeout senza coreutils: alarm sopravvive a exec, SIGALRM chiude il processo
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }

reason=""
quota=$(curl -s -m 5 http://127.0.0.1:3335/api/profiles | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(("esaurita " + str(d.get("earliestReset") or "unknown")) if d.get("allExhausted") else "ok")
except Exception:
    print("ignota")' 2>/dev/null)

if [[ $quota == esaurita* ]]; then
  reset=${quota#esaurita }
  reason="quota Claude finita su entrambi gli account$([[ $reset != unknown ]] && echo ", torna alle $reset")"
  log "salto claude: $reason"
else
  if [[ -z ${BRIEF_FORCE_FALLBACK:-} ]]; then
    # sonnet e non opus dal 05/10: il brief è riassunto e triage, Opus costava ~5x per lo stesso testo
    limit "$CLAUDE_MAX" claude -p --model sonnet --effort medium --permission-mode bypassPermissions \
      --append-system-prompt "$SYSTEM" < "$work/prompt" > "$work/out" 2>> "$ERRLOG"
    rc=$?
    if [[ $rc -eq 0 && -s $work/out ]]; then
      used=claude
    else
      reason=$([[ $rc -eq 142 ]] && echo "Claude non ha risposto entro $((CLAUDE_MAX / 60)) minuti" || echo "Claude è uscito con errore $rc")
      log "claude fallito: $reason"
    fi
  else
    reason="fallback forzato (prova)"
  fi
fi

if [[ -z ${used:-} ]]; then
  # modello esplicito: col login ChatGPT i gpt-6-* danno 400 (provato 04/10), il default
  # gpt-6.1-sol di ~/.codex/config.toml compreso; effort medio perche il default e ultra
  limit "$CODEX_MAX" codex exec -m gpt-5.6-sol -c model_reasoning_effort=medium --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
    -C "$PWD" -o "$work/out" - < "$work/prompt" > /dev/null 2> "$work/codex.err"
  rc=$?
  if [[ $rc -eq 0 && -s $work/out ]]; then
    used=codex
    log "brief fatto con codex ($reason)"
  else
    # codex ripete il prompt su stderr: nel log va solo la coda
    log "anche codex fallito (exit $rc): $(grep -m1 '^ERROR' "$work/codex.err" || tail -1 "$work/codex.err")"
  fi
fi

if [[ -z ${used:-} ]]; then
  msg="⚠️ Brief di stamattina non generato: $reason; anche il piano B (ChatGPT/codex) non ha risposto. Riprovo domani alle 7:30."
  echo "$msg"
  printf '%s\n' "$msg" > "$BRIEF_FILE"
  exit 0
fi

[[ $used == codex ]] && printf '_(brief fatto con ChatGPT: %s)_\n\n' "$reason"
cat "$work/out"
# Il prompt chiede al modello di scrivere il file per «vai archivio»; se non l'ha fatto, almeno il
# testo inviato c'e' (senza ID: la sessione WhatsApp li cerca con gws-mail).
if [[ ! $BRIEF_FILE -nt $work/start ]]; then
  log "il modello non ha scritto $BRIEF_FILE: lo scrivo dal suo output"
  cp "$work/out" "$BRIEF_FILE"
fi
