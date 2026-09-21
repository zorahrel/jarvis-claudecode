#!/usr/bin/env bash
# Suite di devreap. Usa processi VERI (python che alloca e ascolta davvero),
# non mock: il bug del 21/09 e' sfuggito proprio perche' `ps` mentiva sul
# footprint di Bun, e un test con `ps` finto non lo avrebbe mai visto.
#
# I finti vivono sotto ~/Projects/.devreap-test/ perche' devreap opera solo
# dentro ~/Projects: un test fuori da li' proverebbe un altro programma.
set -uo pipefail

REAP="$HOME/.claude/jarvis/scripts/devreap/devreap"
SANDBOX="$HOME/Projects/.devreap-test/node_modules/.bin"
STATE="$HOME/.claude/jarvis/state/devreap.json"
STATE_BAK="$STATE.testbak"
PIDS=()
PASS=0; FAIL=0

cleanup() {
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null; done
  # I PID noti non bastano: devreap puo' averne gia' ucciso il padre lasciando
  # figli, e un test che lascia in giro 700 MB di finti e' peggio del bug.
  pkill -9 -f "Projects/.devreap-test" 2>/dev/null
  sleep 1
  rm -rf "$HOME/Projects/.devreap-test"
  [ -f "$STATE_BAK" ] && mv "$STATE_BAK" "$STATE" || rm -f "$STATE"
}
trap cleanup EXIT

ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (atteso '$3', avuto '$2')"; fi; }

[ -f "$STATE" ] && cp "$STATE" "$STATE_BAK"
rm -f "$STATE"
mkdir -p "$SANDBOX"

# Un finto dev server: alloca davvero `mb` di RAM, ascolta davvero su `porta`,
# e il suo argv[0] deve matchare i pattern di devreap (node_modules/.bin/next).
cat > "$SANDBOX/fake.py" <<'PY'
import socket, sys, time
port, mb = int(sys.argv[1]), int(sys.argv[2])
blob = bytearray(mb * 1024 * 1024)          # allocazione vera, non riservata
for i in range(0, len(blob), 4096):
    blob[i] = 1                              # tocca le pagine: footprint reale
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(8)
conns = []
while True:
    s.settimeout(0.5)
    try: conns.append(s.accept()[0])
    except Exception: pass
    time.sleep(0.2)
PY
cp "$SANDBOX/fake.py" "$SANDBOX/next"        # il nome che devreap riconosce

spawn() {  # spawn <porta> <mb> -> pid
  python3 "$SANDBOX/next" "$1" "$2" >/dev/null 2>&1 &
  local p=$!; PIDS+=("$p"); echo "$p"
}

echo "== setup: due finti dev server (uno grosso e solo, uno grosso ma in uso)"
LONE=$(spawn 39101 700)       # grosso, nessuno connesso -> va raccolto
BUSY=$(spawn 39102 700)       # grosso, ma con un client attaccato -> si salva
sleep 4
exec 9<>/dev/tcp/127.0.0.1/39102 || bad "non riesco a connettermi al finto in uso"
sleep 2

# Soglie abbassate: 500 MB invece di 6 GB, gate swap a 0, 2 strike, 5 kill.
# DEVREAP_ONLY_PATH e' il recinto ed e' OBBLIGATORIO: senza, queste soglie
# valgono per tutta la macchina e la suite falcia i dev server veri. E'
# successo il 21/09 su :3200 mentre provavo il reaper.
export DEVREAP_FOOTPRINT_MB=500 DEVREAP_SWAP_PCT=0 DEVREAP_STRIKES=2 DEVREAP_KILLS=5
export DEVREAP_ONLY_PATH="$HOME/Projects/.devreap-test"

echo
echo "== 1. il censimento li vede entrambi e distingue chi e' in uso"
OUT=$("$REAP" --list)
echo "$OUT" | grep -q "39101" && ok "vede il solitario" || bad "non vede il solitario"
echo "$OUT" | grep -q "39102" && ok "vede quello in uso" || bad "non vede quello in uso"
check "conta la connessione entrante" \
  "$(echo "$OUT" | grep 39102 | grep -o 'conn=[0-9]*' | head -1)" "conn=1"
check "il solitario risulta senza connessioni" \
  "$(echo "$OUT" | grep 39101 | grep -o 'conn=[0-9]*' | head -1)" "conn=0"

echo
echo "== 2. una passata sola non uccide (serve il secondo strike)"
"$REAP" >/dev/null 2>&1
kill -0 "$LONE" 2>/dev/null && ok "dopo 1 strike e' ancora vivo" || bad "ucciso al primo colpo"

echo
echo "== 3. al secondo strike raccoglie il solitario e risparmia quello in uso"
"$REAP" >/dev/null 2>&1
sleep 7
kill -0 "$LONE" 2>/dev/null && bad "il solitario e' sopravvissuto" || ok "solitario raccolto"
kill -0 "$BUSY" 2>/dev/null && ok "quello in uso e' intatto" || bad "ucciso un server in uso"

echo
echo "== 4. il gate di pressione: con swap sotto soglia non tocca niente"
LONE2=$(spawn 39103 700); sleep 4
DEVREAP_SWAP_PCT=999 "$REAP" >/dev/null 2>&1
DEVREAP_SWAP_PCT=999 "$REAP" >/dev/null 2>&1
DEVREAP_SWAP_PCT=999 "$REAP" >/dev/null 2>&1
sleep 2
kill -0 "$LONE2" 2>/dev/null && ok "sotto pressione-soglia non uccide" || bad "ha ucciso senza emergenza"

echo
echo "== 5. --dry-run decide ma non spara"
"$REAP" --dry-run >/dev/null 2>&1
"$REAP" --dry-run >/dev/null 2>&1
"$REAP" --dry-run >/dev/null 2>&1
sleep 2
kill -0 "$LONE2" 2>/dev/null && ok "dry-run non ha ucciso" || bad "dry-run ha ucciso davvero"

echo
echo "== 6. non tocca cio' che sta fuori da ~/Projects ne' i protetti"
grep -q "topics-app/server.ts" "$REAP" && ok "server.ts di Topics e' in PROTECTED" || bad "Topics non protetto"
OUT=$("$REAP" --list)
echo "$OUT" | grep -q "bun test" && bad "considera 'bun test' un dev server" || ok "ignora i test runner"

echo
echo "== 7. il caso del 21/09: un albero next dev senza connessioni viene visto grosso"
check "footprint letto via footprint(1), non ps" \
  "$(grep -c 'footprint", "-p"' "$REAP")" "1"

exec 9<&- 2>/dev/null
echo
echo "== 8. il recinto: con soglie da test i processi veri restano invisibili"
# Il piu' grosso dev server reale della macchina (se c'e') non deve comparire
# nemmeno nel censimento mentre ONLY_PATH e' attivo.
REAL=$("$REAP" --list | grep -vE "3910[0-9]|swap usato|^$" | grep -c "porte=" || true)
check "col recinto attivo vede solo i finti" "$REAL" "0"
OUT_NOFENCE=$(DEVREAP_ONLY_PATH= "$REAP" --list | grep -c "porte=" || true)
[ "$OUT_NOFENCE" -gt 0 ] && ok "senza recinto vede la macchina vera (il recinto conta)" \
                         || bad "senza recinto non vede nulla: il test 8 non prova niente"

echo
echo "passati $PASS, falliti $FAIL"
[ "$FAIL" -eq 0 ]
