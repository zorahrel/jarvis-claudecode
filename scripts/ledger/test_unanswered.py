"""Barra del rilevatore «Jarvis non ha risposto»: python3 test_unanswered.py, esce 1 se sbaglia.
Fixture ricalcata sugli eventi veri di OpenClaw (05/10 «ci sei?» -> NO_REPLY; prove da jcode senza senderId)."""
import json, os, sqlite3, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger

NOW = 1_800_000_000_000
MIN = 60 * 1000
OWNER = {'senderIsOwner': True, 'senderId': '+390000000000', 'transport': {'channel': 'whatsapp'}}


def user(text, meta=OWNER):
    return {'type': 'message', 'message': {'role': 'user', 'content': text, '__openclaw': meta}}


def bot(text, **extra):
    return {'type': 'message', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}], **extra}}


# sessione -> (chat_type, [(minuti fa, evento)]); il nome dice l'esito atteso
CASES = {
    'muto-no-reply': ('direct', [(60, user('ci sei?')), (59, bot('NO_REPLY'))]),
    'muto-niente': ('direct', [(90, user('Cerca bene'))]),
    'risposto': ('direct', [(60, user('come va')), (59, bot('Bene, dimmi.'))]),
    'risposto-col-tool': ('direct', [(60, user('cerca')), (59, bot('Eccolo', openclawDelivery={'mediaUrls': []}, model='delivery-mirror')),
                                     (59, bot('NO_REPLY'))]),
    'prova-jcode': ('direct', [(60, user('Reply with exactly: PING-OK', {'senderIsOwner': True}))]),
    'gruppo': ('group', [(60, user('ci vediamo alle 5'))]),
    'ancora-in-tempo': ('direct', [(5, user('fatto?'))]),
    'risposto-poi-muto': ('direct', [(120, user('a')), (119, bot('ok')), (40, user('e poi?')), (39, bot('HEARTBEAT_OK'))]),
    'muto-dopo-tool': ('direct', [(60, user('ci sei?')), (59, {'type': 'message', 'message': {'role': 'assistant',
                       'content': [{'type': 'toolCall', 'name': 'exec'}]}}), (58, bot('NO_REPLY'))]),
}
EXPECTED = {'muto-no-reply', 'muto-niente', 'risposto-poi-muto', 'muto-dopo-tool'}


def build(path):
    con = sqlite3.connect(path)
    con.execute('create table session_windows (session_id text, chat_type text)')
    con.execute('create table transcript_events (session_id text, seq int, event_json text, created_at int)')
    for sid, (chat, events) in CASES.items():
        con.execute('insert into session_windows values (?, ?)', (sid, chat))
        for seq, (ago, e) in enumerate(events):
            con.execute('insert into transcript_events values (?, ?, ?, ?)', (sid, seq, json.dumps(e), NOW - ago * MIN))
    con.commit()


with tempfile.TemporaryDirectory() as d:
    db = os.path.join(d, 'oc.sqlite')
    build(db)
    got = {u['session'] for u in ledger.unanswered(hours=24, grace_min=20, db=db, now=NOW)}
    later = {u['session'] for u in ledger.unanswered(hours=24, grace_min=20, db=db, now=NOW + 30 * MIN)}

ok = got == EXPECTED and later == EXPECTED | {'ancora-in-tempo'}
print('ok' if ok else f'SBAGLIATO\n  attesi {sorted(EXPECTED)}\n  trovati {sorted(got)}\n  dopo 30 min {sorted(later)}')
sys.exit(0 if ok else 1)
