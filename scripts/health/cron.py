#!/usr/bin/env python3
"""Probe dei cron del router Jarvis.

Legge /api/crons su stdin e stampa una riga STATO|nome|messaggio per job.

Perche' non basta guardare consecutiveErrors: un cron che smette di partire ha
errori a zero e lastRun vecchio, quindi con il solo filtro sugli errori era
invisibile. Qui la staleness si misura contro il periodo dedotto dallo schedule.
"""
import json
import sys
import time


def period_days(schedule: str) -> float | None:
    """Periodo atteso in giorni, dedotto dai 5 campi di un'espressione cron."""
    fields = schedule.split()
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


def main() -> int:
    try:
        jobs = json.load(sys.stdin)
    except Exception as exc:
        print(f"FAIL|api|/api/crons non parsabile: {exc}")
        return 0

    now = time.time()
    for job in jobs:
        name = job.get("name", "?")

        if not job.get("enabled", True):
            print(f"SKIP|{name}|disabilitato")
            continue

        errors = job.get("consecutiveErrors", 0)
        if errors > 2:
            detail = job.get("lastError") or "nessun dettaglio"
            print(f"FAIL|{name}|{errors} errori consecutivi: {detail}")
            continue

        period = period_days(job.get("schedule", ""))
        last = (job.get("lastRun") or 0) / 1000

        if not last:
            print(f"WARN|{name}|non ha mai girato")
        elif period and (now - last) > period * 86400 * 2:
            days = int((now - last) / 86400)
            print(f"WARN|{name}|fermo da {days}g, atteso ogni {period:g}g")
        else:
            print(f"OK|{name}|ultimo {int((now - last) / 3600)}h fa")

    return 0


if __name__ == "__main__":
    sys.exit(main())
