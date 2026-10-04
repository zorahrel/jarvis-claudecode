#!/usr/bin/env python3
"""Probe dei cron di Jarvis, che dal 29/09/2026 vivono in OpenClaw.

Legge `openclaw cron list --json` su stdin e stampa una riga STATO|nome|messaggio
per job. (Prima leggeva /api/crons del router, che ora non ha piu' cron.)

Perche' non basta guardare gli errori: un cron che smette di partire ha errori a
zero e lastRun vecchio, quindi con il solo filtro sugli errori era invisibile. Qui
la staleness si misura contro il periodo dedotto dallo schedule. E un run «ok» che
non consegna (es. «No active WhatsApp Web listener», settembre 2026) era
altrettanto invisibile: l'errore di consegna ora e' un WARN.
"""
import json
import subprocess
import sys
import time


def period_days_from_expr(expr: str) -> float | None:
    """Periodo atteso in giorni, dedotto dai 5 campi di un'espressione cron."""
    fields = expr.split()
    if len(fields) != 5:
        return None
    _minute, hour, dom, _month, dow = fields
    if dow != "*":
        return 7
    if dom != "*":
        return 31
    if hour != "*":
        return 1
    return 1 / 24


def period_days(schedule: dict) -> float | None:
    kind = schedule.get("kind")
    if kind == "cron":
        return period_days_from_expr(schedule.get("expr", ""))
    if kind == "every" and schedule.get("everyMs"):
        return schedule["everyMs"] / 86_400_000
    return None


def last_run_error(job_id: str | None) -> str:
    """Errore dell'ultimo run fallito, dallo storico (`openclaw cron runs`)."""
    if not job_id:
        return "nessun dettaglio"
    try:
        out = subprocess.run(["openclaw", "cron", "runs", job_id, "--json", "--limit", "10"],
                             capture_output=True, text=True, timeout=30).stdout
        for run in json.loads(out[out.find("{"):]).get("entries", []):
            if run.get("status") == "error" and run.get("error"):
                return run["error"]
    except Exception:
        pass
    return "nessun dettaglio nello storico dei run"


def main() -> int:
    try:
        jobs = json.load(sys.stdin)["jobs"]
    except Exception as exc:
        print(f"FAIL|api|openclaw cron list --json non parsabile: {exc}")
        return 0

    now = time.time()
    for job in jobs:
        name = job.get("name") or job.get("displayName") or job.get("id", "?")
        state = job.get("state") or {}

        if not job.get("enabled", True):
            print(f"SKIP|{name}|disabilitato")
            continue

        errors = state.get("consecutiveErrors") or 0
        if errors > 2:
            # A run partito OpenClaw azzera lastError ma tiene il conteggio: il brief
            # che controlla se stesso leggeva «nessun dettaglio» (04/10). Il motivo
            # vero sta nello storico dei run.
            detail = state.get("lastError") or job.get("lastError") or last_run_error(job.get("id"))
            if state.get("runningAtMs"):
                print(f"WARN|{name}|in corso adesso; i {errors} giri prima sono falliti: {detail[:160]}")
            else:
                print(f"FAIL|{name}|{errors} errori consecutivi: {detail[:160]}")
            continue

        schedule = job.get("schedule") or {}
        last = (job.get("lastRunAtMs") or state.get("lastRunAtMs") or 0) / 1000
        delivery_error = job.get("lastDeliveryError") or state.get("lastDeliveryError")
        run_end = last + (state.get("lastDurationMs") or 0) / 1000

        if schedule.get("kind") == "at":
            # One-shot: prima della data e' solo in attesa, dopo deve aver girato.
            due = (job.get("nextRunAtMs") or state.get("nextRunAtMs") or 0) / 1000
            if due and due > now:
                print(f"OK|{name}|una volta, parte il {time.strftime('%d/%m %H:%M', time.localtime(due))}")
                continue

        period = period_days(schedule)
        if not last:
            print(f"WARN|{name}|non ha mai girato")
        elif period and (now - last) > period * 86400 * 2:
            days = int((now - last) / 86400)
            print(f"WARN|{name}|fermo da {days}g, atteso ogni {period:g}g")
        elif delivery_error and (job.get("updatedAtMs") or 0) / 1000 > run_end + 600:
            # L'errore e' di un run fatto con la config di prima: il job e' stato
            # corretto dopo, quindi lo dira' il prossimo run, non questo. updatedAtMs
            # si sposta anche a fine run (e fino a un minuto dopo, col recupero della
            # consegna): conta come modifica solo oltre 10 minuti dalla fine.
            print(f"OK|{name}|non consegnato all'ultimo run, ma il job e' stato modificato dopo")
        elif delivery_error and "No active WhatsApp Web listener" in delivery_error:
            # Il testo dell'errore suggerisce `openclaw channels login`, ma il socket
            # e' su: e' il bug OpenClaw #153453 dei job agentTurn (il run cerca il
            # listener in un altro registry). Il recupero di solito consegna dopo
            # qualche minuto; i job con payload command consegnano al primo colpo.
            print(f"WARN|{name}|consegna WhatsApp fallita al primo tentativo: bug OpenClaw #153453 dei job agentTurn, non un login da rifare. Rimedio: payload command")
        elif delivery_error:
            print(f"WARN|{name}|ha girato ma non ha consegnato: {delivery_error[:120]}")
        else:
            print(f"OK|{name}|ultimo {int((now - last) / 3600)}h fa")

    return 0


if __name__ == "__main__":
    sys.exit(main())
