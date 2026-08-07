#!/usr/bin/env python3
"""Probe dei dispositivi companion WhatsApp.

Legge /api/whatsapp/status su stdin, incrocia con la device-list che Baileys
tiene in cache sotto wa-auth/, e stampa righe STATO|nome|messaggio.

Perche' esiste: WhatsApp sopprime le push sul telefono finche' un qualsiasi
dispositivo companion risulta online, e Jarvis e' solo UNO dei companion. Il
07/08/2026 il colpevole era Beeper, non il router, e per stabilirlo sono
serviti quaranta minuti di scavo nei log. Questa riga li riduce a zero.

Attenzione: device-list-*.json e' una cache locale di Baileys. Non si aggiorna
in tempo reale quando scolleghi un dispositivo dal telefono, quindi un
companion appena rimosso puo' restare elencato per un po'.
"""
import json
import os
import sys
import time

WA_AUTH = os.environ.get(
    "WA_AUTH", os.path.expanduser("~/.claude/jarvis/router/wa-auth")
)


def lid_base() -> str | None:
    """Base del LID dell'account, da creds.json.

    creds.me.lid ha forma "8710244028519:62@lid" -> "8710244028519".

    Va letta, non indovinata: wa-auth contiene una device-list per contatto e
    moltissimi contatti hanno a loro volta un device :62, quindi selezionare
    "la device-list che contiene il nostro device id" becca il primo file di un
    estraneo e riporta un falso "nessun companion". E' esattamente il bug che
    questo probe ha prodotto alla prima esecuzione.
    """
    try:
        creds = json.load(open(os.path.join(WA_AUTH, "creds.json")))
    except Exception:
        return None
    lid = (creds.get("me") or {}).get("lid") or ""
    return lid.split(":")[0] or None


def describe(base: str, device: str) -> str:
    """Device id piu' eta' dell'ultima sessione scritta, se disponibile."""
    session = os.path.join(WA_AUTH, f"session-{base}_1.{device}.json")
    if not os.path.exists(session):
        return f":{device} mai visto"
    minutes = int((time.time() - os.path.getmtime(session)) / 60)
    return f":{device} visto {minutes}min fa"


def main() -> int:
    try:
        status = json.load(sys.stdin)
    except Exception as exc:
        print(f"FAIL|socket|stato non parsabile: {exc}")
        return 0

    state = status.get("status")
    jid = status.get("jid") or ""
    if state != "connected":
        print(f'FAIL|socket|stato "{state}"')
        return 0

    # selfJid "393313998288:62@s.whatsapp.net" -> device "62"
    mine = jid.split(":")[1].split("@")[0] if ":" in jid else "?"
    print(f"OK|socket|connesso come device :{mine}")

    base = lid_base()
    if not base:
        print("WARN|companion|LID base non leggibile da creds.json")
        return 0

    path = os.path.join(WA_AUTH, f"device-list-{base}.json")
    if not os.path.exists(path):
        print(f"WARN|companion|device-list-{base}.json assente in wa-auth")
        return 0

    try:
        devices = json.load(open(path))
    except Exception as exc:
        print(f"WARN|companion|device-list illeggibile: {exc}")
        return 0

    # "0" e' il telefono, `mine` e' Jarvis: tutto il resto e' un companion che
    # puo' tenere l'account "online" e zittire le notifiche del telefono.
    others = [d for d in devices if d not in ("0", mine)]
    if not others:
        print("OK|companion|nessun altro dispositivo collegato")
        return 0

    detail = ", ".join(describe(base, d) for d in others)
    print(
        f"WARN|companion|{len(others)} altri collegati ({detail})"
        " — possono sopprimere le push sul telefono"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
