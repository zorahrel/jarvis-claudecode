#!/usr/bin/env bash
# Suite di openclaw-safe-update. `openclaw`, `npm`, `launchctl`, `agents-doctor`, `trash` e la
# patch MCP sono finti, in testa al PATH, e HOME e' una cartella temporanea: la suite non tocca
# mai l'OpenClaw vero (ne' ~/.openclaw ne' lo stato in ~/.claude/jarvis/state).
#
# Il finto tiene lo stato in un JSON (versione installata, plugin, patch, pid del gateway, guasti
# da iniettare) e scrive ogni chiamata in calls.log: i test guardano cosa e' stato chiamato.
#
#   openclaw-safe-update-test.sh             la suite
#   OSU_SCRIPT=<copia> ...test.sh            la stessa suite su una copia mutata dello script
set -uo pipefail

SCRIPT="${OSU_SCRIPT:-$(cd "$(dirname "$0")" && pwd)/openclaw-safe-update}"
T=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/osu-test.XXXXXX")" && pwd -P)  # niente // nel percorso: Python lo normalizza
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()   { echo "  ok   $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (atteso '$3', avuto '$2')"; fi; }
has()  { grep -q -- "$2" "$3" && ok "$1" || bad "$1 (manca '$2' in ${3##*/})"; }
hasnt(){ grep -q -- "$2" "$3" && bad "$1 (c'e' '$2' in ${3##*/})" || ok "$1"; }

mkdir -p "$T/bin"
cat > "$T/bin/fake.py" <<'PY'
#!/usr/bin/env python3
import json, os, sys, time
S = os.environ["FAKE_STATE"]
st = json.load(open(S))
name, args = os.path.basename(sys.argv[0]), sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as f:
    f.write(" ".join([name] + args) + "\n")
def save(): json.dump(st, open(S, "w"))
def out(o): print(json.dumps(o))
def healthy(): return st["version"] != st.get("bad_version")
a = " ".join(args)

if name == "launchctl":
    if args[0] == "print" and "ai.openclaw.gateway" in a:
        print(f"state = running\n\tpid = {st['pid']}")
    elif args[0] == "print":
        sys.exit(113)
    elif args[0] == "kickstart":
        st["pid"] += 1
        st["patch_live"] = st["patched"]
        save()
    sys.exit(0)

if name == "mcp-lazy":
    if args[0] == "check":
        ok = st["patched"] and st["patch_live"]
        print("ok   patch attiva" if ok else "FAIL patch openclaw-mcp-lazy assente")
        sys.exit(0 if ok else 1)
    if args[0] == "upstream":
        sys.exit(1)
    if args[0] == "apply":
        st["patched"] = True; save(); print("patch applicata"); sys.exit(0)

if name == "agents-doctor":
    print("ok   qualcosa")
    for x in st.get("doctor_fails", []): print("FAIL " + x)
    sys.exit(1 if st.get("doctor_fails") else 0)

if name == "trash":
    sys.exit(0)

if name == "npm":
    if args[:2] == ["view", "@openclaw/whatsapp"] and "versions" in args:
        out(["2026.9.5", "2026.9.6", "2026.9.7"]); sys.exit(0)
    if args[0] == "view":
        out(">=" + args[1].rsplit("@", 1)[1]); sys.exit(0)
    if args[0] in ("i", "install"):
        st["version"] = args[2].split("@", 1)[1]; st["patched"] = st["patch_live"] = False
        save(); sys.exit(0)
    sys.exit(1)

# ---- openclaw
if args == ["--version"]:
    print(f"OpenClaw {st['version']} (fake)"); sys.exit(0)
if args[:2] == ["update", "status"]:
    time.sleep(st.get("status_sleep", 0))
    out({"update": {"root": os.environ["FAKE_ROOT"]},
         "availability": {"latestVersion": st["latest"]}, "lastRun": st.get("last_run", {})})
    sys.exit(0)
if args[0] == "update":
    tag = args[args.index("--tag") + 1]
    fail = st.get("update_fail")
    if fail and tag == st["latest"]:
        run = {"status": fail, "reason": "managed-service-preflight",
               "steps": [{"step": "managed-service-preflight", "status": "failed",
                          "failureFacts": [{"message": "This command is running inside the gateway process tree (gateway PID 42)."}]}]}
        st["last_run"] = run; save(); out({"run": run}); sys.exit(1)
    st["version"] = tag; st["patched"] = st["patch_live"] = False; st["pid"] += 1
    if not st.get("no_converge"): st["plugin"] = tag
    st["last_run"] = {"status": "succeeded"}; save(); out({"run": {"status": "succeeded"}}); sys.exit(0)
if args[:2] == ["tasks", "list"]:
    n = st.get("tasks_running", 0) if "running" in args else 0
    out({"count": n, "tasks": [{}] * n}); sys.exit(0)
if args[:1] == ["health"]:
    out({"ok": True, "plugins": {"loaded": ["whatsapp"], "errors": []},
         "channels": {"whatsapp": {"accounts": {"default": {"activeRuns": st.get("active_runs", 0)}}}}}); sys.exit(0)
if args[:2] == ["channels", "status"]:
    out({"channels": {"whatsapp": {"configured": True, "running": True, "connected": True, "linked": True,
                                    "healthState": "healthy" if healthy() else "unstable"}}}); sys.exit(0)
if args[:2] == ["gateway", "status"]:
    out({"rpc": {"ok": True, "server": {"version": st["version"]}}}); sys.exit(0)
if args[:2] == ["plugins", "list"]:
    out({"plugins": [{"id": "whatsapp", "version": st["plugin"], "origin": "global",
                      "trust": {"installSpec": "@openclaw/whatsapp@" + st["plugin"]}}]}); sys.exit(0)
if args[:2] == ["plugins", "install"]:
    if st.get("plugin_fail"): print("Plugin replacement failed", file=sys.stderr); sys.exit(1)
    st["plugin"] = args[2].rsplit("@", 1)[1]; save(); sys.exit(0)
if args[:2] == ["config", "get"]:
    print("false"); sys.exit(0)
if args[:2] == ["config", "set"]:
    sys.exit(0)
if args[:3] == ["backup", "sqlite", "create"]:
    sys.exit(0)
if args[:2] == ["cron", "list"]:
    out({"jobs": [{"id": "hb-1", "name": "heartbeat-main"}]}); sys.exit(0)
if args[:2] == ["cron", "run"]:
    err = "heartbeat failed: No active WhatsApp Web listener (account: default)" if st.get("hb_wa_bug") else ""
    st["hb"] = {"ts": time.time() * 1000, "status": "ok" if healthy() and not err else "error", "error": err}
    save(); sys.exit(0)
if args[:2] == ["cron", "runs"]:
    out({"entries": [st["hb"]] if st.get("hb") else []}); sys.exit(0)
if args[:2] == ["cron", "get"]:
    out({"delivery": {"channel": "whatsapp", "to": "+15550100000"}}); sys.exit(0)
if args[:2] == ["message", "send"]:
    with open(os.environ["FAKE_MSGS"], "a") as f: f.write(args[args.index("-m") + 1] + "\n")
    sys.exit(0)
print("fake openclaw: comando non previsto: " + a, file=sys.stderr); sys.exit(2)
PY
chmod +x "$T/bin/fake.py"
# il nome del finto e' quello vero: fake.py smista su argv[0]
for n in openclaw npm launchctl agents-doctor trash mcp-lazy; do ln -s "$T/bin/fake.py" "$T/bin/$n"; done

# setup <json di stato> : HOME nuova, root finta di OpenClaw, log vuoti
setup() {
  export HOME="$T/home-$RANDOM" FAKE_STATE="$T/state.json" FAKE_CALLS="$T/calls.log" FAKE_MSGS="$T/msgs.log"
  export FAKE_ROOT="$T/root" PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" OSU_MCP_LAZY="$T/bin/mcp-lazy"
  export OSU_POLL_S=0.1 OSU_SETTLE_S=1 OSU_POST_IDLE_MIN=0.01 OSU_MIN_FREE_GB=0
  unset OPENCLAW_GATEWAY_SERVICE_PID OPENCLAW_CONFIG_PATH
  mkdir -p "$HOME/.claude/jarvis/state" "$HOME/.openclaw" "$FAKE_ROOT/dist"
  echo '{"update":{"auto":{"enabled":false}}}' > "$HOME/.openclaw/openclaw.json"
  echo 'x' > "$FAKE_ROOT/dist/mcp-http.schema-AAA.mjs"
  : > "$FAKE_CALLS"; : > "$FAKE_MSGS"
  python3 -c "
import json,sys
st={'version':'2026.9.5','latest':'2026.9.7','plugin':'2026.9.5','pid':1000,'patched':True,'patch_live':True}
st.update(json.loads(sys.argv[1])); json.dump(st,open('$FAKE_STATE','w'))" "${1:-{\}}"
}
arm() { echo '{"armed": true}' > "$HOME/.claude/jarvis/state/openclaw-safe-update.json"; }
sget() { python3 -c "import json;print(json.load(open('$FAKE_STATE'))['$1'])"; }
go() { "$SCRIPT" --idle-wait 0 "$@" > "$T/out.log" 2>&1; echo $?; }

echo "== 1. nessuna versione nuova: esce 0, non aggiorna, non scrive ad Attilio"
setup '{"latest":"2026.9.5"}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
hasnt "nessun riavvio" "kickstart" "$T/calls.log"
check "nessuna notifica" "$(wc -l < "$T/msgs.log" | tr -d ' ')" 0

echo "== 2. OpenClaw occupato: nessuna azione, riprova la notte dopo"
setup '{"tasks_running":1}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
hasnt "nessun backup" "backup sqlite" "$T/calls.log"
has "dice perche'" "1 task attivi" "$T/out.log"
setup '{"active_runs":2}'; arm
go >/dev/null
hasnt "un run sul canale basta a fermarlo" "update --yes" "$T/calls.log"
setup; arm; P="$HOME/.claude/projects/$(printf %s "$HOME" | sed 's/[^A-Za-z0-9]/-/g')--openclaw"
mkdir -p "$P" && touch "$P/s.jsonl"
go >/dev/null
hasnt "un transcript di 0 s fa basta a fermarlo" "update --yes" "$T/calls.log"

echo "== 3. update ok: plugin allineato, patch rimessa, un riavvio, health ok, notifica"
setup '{"no_converge":true}'; arm
check "exit 0" "$(go)" 0
check "core" "$(sget version)" 2026.9.7
check "plugin whatsapp" "$(sget plugin)" 2026.9.7
has "plugin reinstallato alla versione del core, fissato" "plugins install @openclaw/whatsapp@2026.9.7 --force --pin" "$T/calls.log"
has "patch MCP riapplicata" "mcp-lazy apply" "$T/calls.log"
check "patch viva dopo il riavvio" "$(sget patch_live)" True
check "un solo kickstart" "$(grep -c 'launchctl kickstart' "$T/calls.log")" 1
has "heartbeat vero" "cron run hb-1" "$T/calls.log"
has "backup prima dell'update" "backup sqlite create --global" "$T/calls.log"
has "notifica" "aggiornato 9.5→9.7, tutto verde" "$T/msgs.log"

echo "== 4. il plugin non si installa: rollback e notifica del fallimento"
setup '{"no_converge":true,"plugin_fail":true}'; arm
check "exit 1" "$(go)" 1
has "rollback chiamato" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "tornato a 9.5" "$(sget version)" 2026.9.5
has "notifica del fallimento" "fallito, tornato a 9.5" "$T/msgs.log"
has "col motivo" "plugins install" "$T/msgs.log"

echo "== 5. health gate rosso sulla versione nuova: rollback"
setup '{"bad_version":"2026.9.7"}'; arm
check "exit 1" "$(go)" 1
has "rollback chiamato" "update --yes --json --tag 2026.9.5" "$T/calls.log"
check "tornato a 9.5" "$(sget version)" 2026.9.5
has "notifica col motivo" "whatsapp unstable" "$T/msgs.log"
check "patch viva dopo il rollback" "$(sget patch_live)" True

echo "== 6. lock: un secondo giro non parte mentre il primo e' in corso"
setup; arm
python3 -c "import fcntl,time,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); time.sleep(4)" \
  "$HOME/.claude/jarvis/state/openclaw-safe-update.lock" & HOLD=$!
sleep 0.5
check "exit 3" "$(go)" 3
check "nessuna chiamata a OpenClaw" "$(wc -l < "$T/calls.log" | tr -d ' ')" 0
wait $HOLD

echo "== 7. non armato: il notturno non aggiorna finche' il giro supervisionato non e' andato"
setup
check "exit 0" "$(go)" 0
hasnt "nessun update" "update --yes" "$T/calls.log"
has "lo dice" "non armato" "$T/out.log"

echo "== 8. --dry-run: fotografa e stampa il piano, non tocca niente"
setup; arm
check "exit 0" "$(go --dry-run)" 0
for x in "update --yes" "plugins install" "kickstart" "config set" "backup sqlite" "message send" "mcp-lazy apply"; do
  hasnt "niente $x" "$x" "$T/calls.log"; done
has "piano" "piano: openclaw update --yes --json --tag 2026.9.7" "$T/out.log"

echo "== 9. il giro supervisionato riuscito arma il notturno"
setup
check "exit 0" "$(go --force-version 2026.9.7)" 0
check "armato" "$(python3 -c "import json;print(json.load(open('$HOME/.claude/jarvis/state/openclaw-safe-update.json')).get('armed'))")" True

echo "== 10. OpenClaw rifiuta l'update (managed-service-preflight): niente rollback nostro, motivo preciso"
setup '{"update_fail":"failed"}'; arm
check "exit 1" "$(go)" 1
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "motivo nella notifica" "managed-service-preflight: This command is running inside the gateway process tree" "$T/msgs.log"

echo "== 11. heartbeat rosso solo per il bug di consegna WhatsApp (#153453): non e' colpa dell'update"
setup '{"hb_wa_bug":true}'; arm
check "exit 0" "$(go)" 0
hasnt "nessun rollback" "tag 2026.9.5" "$T/calls.log"
has "lo dice" "bug noto #153453" "$T/out.log"

echo
echo "$PASS ok, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
