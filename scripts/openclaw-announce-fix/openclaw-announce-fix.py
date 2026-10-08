#!/usr/bin/env python3
"""Patch locale di OpenClaw: la fine di un sottoagente arriva su WhatsApp come risposta di Jarvis.

Senza, in chat privata (07/10: 6 volte in un giorno) arrivava il testo grezzo del figlio, tutta la
sua narrazione inglese compresa, con davanti `[truncated-by-retention: complete child answer
unavailable]`. Due difetti di OpenClaw, ancora presenti nel 2026.9.8:

  1. runner claude-cli: salva la risposta senza l'id del run (`__openclaw.runId`), quindi
     l'annuncio non la ritrova e ripiega sul testo del figlio col prefisso. Fix: passare il runId,
     come fanno gli altri percorsi che scrivono nel transcript. E' il fix ufficiale
     (openclaw/openclaw#162843, su main dal 01/10, non nel 2026.9.8): quando arriva in una
     release questo punto risulta gia' fatto e non si tocca.
  2. consegna: in chat privata la fine di un sottoagente vuole lo strumento `message`. Jarvis su
     claude-cli risponde in testo, OpenClaw scarta quella risposta e manda il testo grezzo del
     figlio; se Attilio sta scrivendo (turno "steered") non manda proprio niente. Fix: in privato
     come nei canali Discord, dove la risposta finale di Jarvis si consegna da sola.
     Upstream: openclaw/openclaw#90840, aperta.

Altri due difetti del runner claude-cli, stesso giro (08/10, canale Discord rebricambi):

  3. compattazione: il backend claude-cli dichiara `ownsNativeCompaction` (compatta da solo col
     suo /compact), ma OpenClaw cerca il backend col nome del provider (`anthropic`) invece che
     del runtime (`claude-cli`), non lo trova e compatta via API Anthropic. Senza chiave API
     fallisce a ogni turno (`No API key found for provider "anthropic"`) e la sessione cresce
     fino a rispondere vuoto (605k token). Fix: se il provider non e' un backend, si prova il
     runtime dichiarato in agents.defaults.models["<provider>/<modello>"].agentRuntime.id.
  4. tetto di 20.000 righe JSONL per turno: un sottoagente di 47 minuti lo supera e il suo
     lavoro si butta (`CLI JSONL output exceeded 20000 lines`). Alzato a 200.000: la memoria
     la protegge gia' il tetto di 8 MB sui caratteri, che resta.

  openclaw-announce-fix.py check    exit 0 = patch attiva su disco E nel gateway in esecuzione
  openclaw-announce-fix.py apply    idempotente; poi: launchctl kickstart -k gui/$UID/ai.openclaw.gateway
  openclaw-announce-fix.py revert   toglie la patch (stesso riavvio dopo)

OPENCLAW_DIST=<dir> punta a una copia di dist/ (serve a provarla su una copia).
"""
import glob
import os
import re
import subprocess
import sys
import tempfile
import time

MARK = "jarvis-patch openclaw-announce-fix"

RUN_ID_ORIG = ("\t\tconst idempotencyKey = `cli-assistant:${runParams.runId}`;\n"
               "\t\tconst result = await appendExactAssistantMessageToSessionTranscript({\n"
               "\t\t\tsessionKey: runParams.sessionKey,\n")
RUN_ID_NEW = RUN_ID_ORIG + f"\t\t\trunId: runParams.runId, // {MARK}: senza, l'annuncio non trova la risposta\n"
RUN_ID_UPSTREAM = "\t\t\tidempotencyKey,\n\t\t\trunId: runParams.runId,\n"  # la riga di openclaw#162843
DM_ORIG = ("\t\tconst subagentDirectMessageCompletionRequiresMessageTool = params.expectsCompletionMessage"
           " && isSubagentCompletion && deliveryTarget.deliver"
           " && isDirectMessageDeliveryTarget(deliveryTarget, canonicalRequesterSessionKey);\n")
DM_NEW = (f"\t\tconst subagentDirectMessageCompletionRequiresMessageTool = false;"
          f" // {MARK}: in privato come nei canali\n")
COMPACT_ORIG = "\t\tconst resolvedBackend = cliCompactionDeps.resolveCliBackendConfig(params.provider, params.cfg);\n"
COMPACT_NEW = ("\t\tconst resolvedBackend = cliCompactionDeps.resolveCliBackendConfig(params.provider, params.cfg)"
               " ?? cliCompactionDeps.resolveCliBackendConfig(params.cfg?.agents?.defaults?.models"
               "?.[`${params.provider}/${params.model}`]?.agentRuntime?.id || \"-\", params.cfg);"
               f" // {MARK}: il backend e' il runtime, non il provider\n")
LINES_ORIG = "\tmaxTurnLines: 2e4\n"
LINES_NEW = f"\tmaxTurnLines: 2e5 // {MARK}: 2e4 buttava i sottoagenti lunghi\n"


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


def edits():
    """(file, originale, patchato) per ciascuno dei quattro punti."""
    return [(find("cli-runner-*.mjs", "async function persistCliAssistantTranscript"), RUN_ID_ORIG, RUN_ID_NEW),
            (find("subagent-announce-delivery-*.mjs", "async function sendSubagentAnnounceDirectly"), DM_ORIG, DM_NEW),
            (find("cli-compaction-*.mjs", "async function runCliTurnCompactionLifecycle"), COMPACT_ORIG, COMPACT_NEW),
            (find("cli-live-session-registry-*.mjs", "const CLI_STREAM_JSON_OUTPUT_LIMITS"), LINES_ORIG, LINES_NEW)]


def write(path, text):
    """Sostituzione atomica: il gateway importa questi moduli a richiesta, mai un file a meta'."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".announce-fix-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


def gateway_started_after(paths):
    """True se il gateway in esecuzione e' partito dopo l'ultima modifica dei file patchati."""
    if os.environ.get("OPENCLAW_DIST"):
        return True  # copia di prova: nessun gateway da confrontare
    out = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/ai.openclaw.gateway"], capture_output=True, text=True).stdout
    m = re.search(r"^\s*pid = (\d+)", out, re.M)
    if not m:
        return False
    # etime in secondi dal kernel: niente parsing di date locali
    et = subprocess.run(["ps", "-o", "etime=", "-p", m.group(1)], capture_output=True, text=True).stdout.strip()
    parts = [int(x) for x in re.split(r"[-:]", et)] if et else []
    secs = sum(mult * v for mult, v in zip([1, 60, 3600, 86400], reversed(parts)))
    return time.time() - secs > max(os.path.getmtime(p) for p in paths)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    todo = edits()
    texts = {path: open(path).read() for path, _, _ in todo}
    done = [new in texts[path] for path, _, new in todo]
    done[0] = done[0] or RUN_ID_UPSTREAM in texts[todo[0][0]]
    if cmd == "check":
        if all(done):
            if gateway_started_after([p for p, _, _ in todo]):
                print("ok   patch openclaw-announce-fix attiva (runId claude-cli, fine sottoagente in privato, compattazione claude-cli, tetto righe)")
                return 0
            print("FAIL patch su disco ma il gateway gira col codice vecchio: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
            return 1
        print("FAIL patch openclaw-announce-fix assente (update di OpenClaw?): openclaw-announce-fix.py apply + kickstart"
              f" [runId {'ok' if done[0] else 'no'}, privato {'ok' if done[1] else 'no'},"
              f" compattazione {'ok' if done[2] else 'no'}, righe {'ok' if done[3] else 'no'}]")
        return 1
    if cmd == "apply":
        for (path, orig, new), ok in zip(todo, done):
            if ok:
                continue
            if texts[path].count(orig) != 1:
                sys.exit(f"ERRORE: in {os.path.basename(path)} non trovo il punto atteso: forma cambiata, rivedi la patch a mano")
            write(path, texts[path].replace(orig, new, 1))
        for path, _, _ in todo:
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if r.returncode:
                sys.exit(f"ERRORE di sintassi dopo la patch in {path}: {r.stderr[:300]}")
        print("patch applicata; ora: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
        return 0
    if cmd == "revert":
        for (path, orig, new), ok in zip(todo, done):
            if ok:
                write(path, texts[path].replace(new, orig, 1))
        print("patch tolta; ora: launchctl kickstart -k gui/$UID/ai.openclaw.gateway")
        return 0
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main())
