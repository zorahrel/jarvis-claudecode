#!/usr/bin/env python3
"""Patch locale di OpenClaw: tool MCP del loopback caricati a richiesta (ToolSearch).

OpenClaw scrive `alwaysLoad: true` fisso sul server MCP `openclaw`, quindi Claude Code
manda tutti gli schemi (~46 tool) in ogni chiamata. La patch toglie il flag dal server e
lo rimette tool per tool, via `_meta["anthropic/alwaysLoad"]`, solo sui tool che servono
subito (vedi KEEP). Un update di OpenClaw riscrive dist/ e la patch sparisce: `check` lo dice.

  openclaw-mcp-lazy.py check    exit 0 = patch attiva su disco E nel gateway in esecuzione
  openclaw-mcp-lazy.py apply    idempotente; poi: launchctl kickstart -k gui/$UID/ai.openclaw.gateway
  openclaw-mcp-lazy.py revert   toglie la patch (stesso riavvio dopo)
  openclaw-mcp-lazy.py upstream exit 0 = questa versione ha gia' il fix ufficiale (PR #161392)

Col fix ufficiale la patch non serve e non si applica: OpenClaw differisce i tool da solo, ma
solo se `tools.toolSearch` e' scritto in config. Allora `check` guarda quello e `apply` esce 2
col comando da dare (openclaw config set tools.toolSearch true, si ricarica a caldo).

OPENCLAW_DIST=<dir> punta a una copia di dist/, OPENCLAW_CONFIG_PATH a una copia di
openclaw.json (servono a provare il check su una copia).
Issue upstream: openclaw/openclaw#139477, fix in openclaw/openclaw#161392.
"""
import json
import glob
import os
import re
import subprocess
import sys

# Tool caricati al primo turno. message: heartbeat e cron lo chiamano per primo (read su
# Discord/WhatsApp); i tool sessioni/memoria: li usa l'heartbeat nel 8-22% dei giri;
# sessions_yield: va chiamato subito dopo sessions_spawn. Misure del 29/09 nel cheatsheet.
KEEP = ["message", "sessions_yield", "sessions_list", "sessions_search",
        "sessions_history", "conversations_list", "memory_search", "memory_get"]
MARK = "jarvis-patch openclaw-mcp-lazy"

LOOP_ORIG = "\t\turl: `http://127.0.0.1:${port}/mcp`,\n\t\talwaysLoad: true,\n"
LOOP_NEW = f"\t\turl: `http://127.0.0.1:${{port}}/mcp`,\n\t\t// {MARK}: alwaysLoad per tool in mcp-http.schema\n"
SCHEMA_FN = "/** Builds MCP-compatible tool schemas for loopback-visible gateway tools. */\nfunction buildMcpToolSchema(tools) {"
SCHEMA_CONST = (f"// {MARK}: questi tool restano caricati anche col server differito\n"
                f"const MCP_LOOPBACK_ALWAYS_LOAD_TOOLS = new Set({KEEP!r});\n".replace("'", '"'))
RET_ORIG = "\t\t\tinputSchema: raw\n\t\t};"
RET_NEW = ("\t\t\tinputSchema: raw,\n"
           "\t\t\t...MCP_LOOPBACK_ALWAYS_LOAD_TOOLS.has(name) ? { _meta: { \"anthropic/alwaysLoad\": true } } : {}\n\t\t};")


def dist_dir():
    if os.environ.get("OPENCLAW_DIST"):
        return os.environ["OPENCLAW_DIST"]
    oc = subprocess.run(["which", "openclaw"], capture_output=True, text=True).stdout.strip()
    return os.path.join(os.path.dirname(os.path.realpath(oc)), "dist")


def find(pattern, needle):
    hits = [f for f in glob.glob(os.path.join(dist_dir(), pattern)) if needle in open(f, errors="replace").read()]
    if len(hits) != 1:
        sys.exit(f"ERRORE: {pattern} con «{needle[:40]}»: {len(hits)} file, atteso 1. Forma cambiata: rivedi la patch a mano.")
    return hits[0]


def files():
    return (find("mcp-http.loopback-runtime-*.mjs", "function createMcpServerConfig"),
            find("mcp-http.schema-*.mjs", "function buildMcpToolSchema"))


def state():
    loop, schema = files()
    lt, st = open(loop).read(), open(schema).read()
    return loop, schema, lt, st, (MARK in lt and "alwaysLoad: true" not in lt), (MARK in st and RET_NEW in st)


def upstream_fix(lt, st):
    """Il fix ufficiale si riconosce dal codice, non dalla versione: il loopback sa differire
    (`deferTools`) e lo schema mette da solo il `_meta` per tool."""
    return MARK not in lt and "deferTools" in lt and "anthropic/alwaysLoad" in st


def tool_search_opt_in():
    """True se `tools.toolSearch` e' scritto in config e acceso: e' l'interruttore del fix ufficiale."""
    cfg = os.environ.get("OPENCLAW_CONFIG_PATH") or os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        v = json.load(open(cfg)).get("tools", {}).get("toolSearch")
    except (OSError, ValueError):
        return False
    return v is True or (isinstance(v, dict) and v.get("enabled", True) is not False)


def gateway_started_after(paths):
    """True se il gateway in esecuzione è partito dopo l'ultima modifica dei file patchati."""
    if os.environ.get("OPENCLAW_DIST"):
        return True  # copia di prova: nessun gateway da confrontare
    out = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/ai.openclaw.gateway"], capture_output=True, text=True).stdout
    m = re.search(r"^\s*pid = (\d+)", out, re.M)
    if not m:
        return False
    # etime in secondi dal kernel: niente parsing di date locali
    et = subprocess.run(["ps", "-o", "etime=", "-p", m.group(1)], capture_output=True, text=True).stdout.strip()
    parts = [int(x) for x in re.split(r"[-:]", et)] if et else []
    secs = 0
    for mult, v in zip([1, 60, 3600, 86400], reversed(parts)):
        secs += mult * v
    import time
    return time.time() - secs > max(os.path.getmtime(p) for p in paths)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    loop, schema, lt, st, lok, sok = state()
    if cmd == "upstream":
        up = upstream_fix(lt, st)
        print("fix upstream presente" if up else "fix upstream assente: serve la patch locale")
        return 0 if up else 1
    if upstream_fix(lt, st) and cmd in ("check", "apply"):
        if tool_search_opt_in():
            print("ok   fix upstream presente e tools.toolSearch attivo: la patch locale non serve")
            return 0
        print("FAIL fix upstream presente ma tools.toolSearch non e' in config: openclaw config set tools.toolSearch true")
        return 1 if cmd == "check" else 2
    if cmd == "check":
        if lok and sok:
            if gateway_started_after([loop, schema]):
                print(f"ok   patch openclaw-mcp-lazy attiva ({len(KEEP)} tool sempre caricati)")
                return 0
            print("FAIL patch su disco ma il gateway gira col codice vecchio: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
            return 1
        print("FAIL patch openclaw-mcp-lazy assente (update di OpenClaw?): openclaw-mcp-lazy.py apply + kickstart"
              f" [loopback {'ok' if lok else 'no'}, schema {'ok' if sok else 'no'}]")
        return 1
    if cmd == "apply":
        if not lok:
            if LOOP_ORIG not in lt:
                sys.exit(f"ERRORE: in {os.path.basename(loop)} non trovo il blocco alwaysLoad atteso")
            open(loop, "w").write(lt.replace(LOOP_ORIG, LOOP_NEW, 1))
        if not sok:
            if SCHEMA_FN not in st or RET_ORIG not in st:
                sys.exit(f"ERRORE: in {os.path.basename(schema)} non trovo buildMcpToolSchema nella forma attesa")
            st = st.replace(SCHEMA_FN, SCHEMA_CONST + SCHEMA_FN, 1).replace(RET_ORIG, RET_NEW, 1)
            open(schema, "w").write(st)
        for f in (loop, schema):
            r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            if r.returncode:
                sys.exit(f"ERRORE di sintassi dopo la patch in {f}: {r.stderr[:300]}")
        print("patch applicata; ora: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
        return 0
    if cmd == "revert":
        if lok:
            open(loop, "w").write(lt.replace(LOOP_NEW, LOOP_ORIG, 1))
        if MARK in st:
            open(schema, "w").write(st.replace(SCHEMA_CONST, "", 1).replace(RET_NEW, RET_ORIG, 1))
        print("patch tolta; ora: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
        return 0
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main())
