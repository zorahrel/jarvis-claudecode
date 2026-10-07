#!/usr/bin/env python3
"""ledger: una riga per sessione di ogni harness (Claude Code, Codex, Muse, jcode).

Serve a non perdere i task tra sessioni: chi ha chiesto cosa, dove, come e' finita
(limite di quota, errore, interrotta, ok) e il comando per riprenderla.
Solo lettura. I dati restano locali: l'output va in state/ (gitignorata), mai nel repo.

  ledger.py scan --from 2026-10-01 [--to 2026-10-07T12:00] --out FILE.jsonl
"""
import argparse, glob, json, os, re, sys
from datetime import datetime, timezone
from multiprocessing import Pool
from zoneinfo import ZoneInfo

HOME = os.path.expanduser('~')
ROME = ZoneInfo('Europe/Rome')
# Messaggi di fine quota visti davvero: Claude Code «You've hit your weekly limit · resets 6am»,
# proxy vdm «out of extra usage», Codex «You've hit your usage limit».
LIMIT_RE = re.compile(r"hit your (weekly |session |5-hour |daily |usage )?limit|usage limit|out of extra usage"
                      r"|rate.?limit(ed)?\b|limit reached|quota (exceeded|esaurita)|\b429\b", re.I)
NOISE_RE = re.compile(r'^\s*(<command-|<local-command|<system-reminder>|Caveat:|\[Request interrupted|<task-notification>)')


def ts_of(s):
    """ISO string, epoch s/ms/us -> aware datetime (None se illeggibile)."""
    if s is None: return None
    try:
        if isinstance(s, (int, float)):
            x = float(s)
            x = x / 1e6 if x > 1e14 else x / 1e3 if x > 1e11 else x
            return datetime.fromtimestamp(x, timezone.utc)
        return datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except Exception:
        return None


def clip(t, n=280):
    t = re.sub(r'\s+', ' ', t or '').strip()
    return t if len(t) <= n else t[:n] + '…'


def klass(cwd):
    c = cwd or ''
    if c.startswith(HOME + '/.openclaw'): return 'openclaw'
    if c.startswith(HOME + '/.claude/jarvis'): return 'jarvis'
    if c.startswith(('/private/', '/tmp/', HOME + '/.jcode/scratch')) or 'scratch' in c: return 'tmp'
    if c.startswith(HOME + '/.topics/worktrees'): return 'topics-worktree'
    return 'work'


def end_reason(last_assistant, had_error, aborted):
    if last_assistant and len(last_assistant) < 400 and LIMIT_RE.search(last_assistant): return 'limit'
    if had_error and LIMIT_RE.search(had_error): return 'limit'
    if had_error: return 'error'
    if aborted: return 'interrupted'
    return 'ok'


def rec(h, sid, cwd, start, end, prompts, last_assistant, reason, resume, extra=None):
    r = dict(harness=h, id=sid, cwd=cwd, klass=klass(cwd), start=start.isoformat() if start else None,
             end=end.isoformat() if end else None, user_turns=len(prompts),
             first_prompt=clip(prompts[0]) if prompts else '', last_prompt=clip(prompts[-1]) if prompts else '',
             last_assistant=clip(last_assistant, 400), end_reason=reason, resume=resume)
    if extra: r.update(extra)
    return r


# ------------------------------------------------------------------ Claude Code

def cc_text(content):
    if isinstance(content, str): return content
    if isinstance(content, list):
        if any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in content): return None
        return ' '.join(x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text')
    return None


def scan_cc(path):
    prompts, last_a, err, cwd, ep, start, end = [], '', None, None, None, None, None
    for line in open(path, errors='ignore'):
        try: o = json.loads(line)
        except Exception: continue
        t = o.get('type')
        if t not in ('user', 'assistant'): continue
        ts = ts_of(o.get('timestamp'))
        if ts: start = start or ts; end = ts
        cwd = cwd or o.get('cwd'); ep = ep or o.get('entrypoint')
        msg = o.get('message') or {}
        if t == 'user' and not o.get('isMeta') and not o.get('isSidechain'):
            tx = cc_text(msg.get('content'))
            if tx and not NOISE_RE.match(tx): prompts.append(tx)
        elif t == 'assistant':
            tx = cc_text(msg.get('content'))
            if tx: last_a = tx
            if o.get('isApiErrorMessage'): err = tx or 'api error'
            elif tx: err = None  # errore superato da una risposta successiva
    if not prompts: return None
    sid = os.path.basename(path)[:-6]
    return rec('claude', sid, cwd, start, end, prompts, last_a, end_reason(last_a, err, False),
               f'cd {cwd} && claude --resume {sid}', {'entrypoint': ep})


# ------------------------------------------------------------------ Codex

def scan_codex(path):
    prompts, last_a, err, cwd, src, start, end, aborted = [], '', None, None, None, None, None, False
    sid = None
    for line in open(path, errors='ignore'):
        try: o = json.loads(line)
        except Exception: continue
        ts = ts_of(o.get('timestamp'))
        if ts: start = start or ts; end = ts
        p = o.get('payload') or {}
        t, pt = o.get('type'), p.get('type')
        if t == 'session_meta':
            sid = p.get('id') or p.get('session_id'); cwd = cwd or p.get('cwd')
            src = p.get('source') if isinstance(p.get('source'), str) else json.dumps(p.get('source'))[:60] if p.get('source') else None
        elif t == 'turn_context':
            cwd = cwd or p.get('cwd')
        elif t == 'event_msg':
            if pt == 'user_message':
                if p.get('message'): prompts.append(p['message'])
            elif pt == 'item_completed':
                it = p.get('item') or {}
                if it.get('type') == 'UserMessage':
                    c = it.get('content')
                    tx = ' '.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else (c or it.get('text') or '')
                    if tx: prompts.append(tx)
                elif it.get('type') == 'AgentMessage':
                    c = it.get('content')
                    tx = ' '.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else (c or it.get('text') or '')
                    if tx: last_a = tx
            elif pt == 'agent_message':
                if p.get('message'): last_a = p['message']
            elif pt == 'task_complete':
                if p.get('last_agent_message'): last_a = p['last_agent_message']
                err = None; aborted = False
            elif pt in ('error', 'stream_error'):
                err = p.get('message') or 'error'
            elif pt == 'turn_aborted':
                aborted = True
    if not prompts or not sid: return None
    # i prompt che Codex inietta da solo non sono richieste
    prompts = [x for x in prompts if not x.lstrip().startswith(('<environment_context>', '# AGENTS.md', '<user_instructions>'))] or prompts
    return rec('codex', sid, cwd, start, end, prompts, last_a, end_reason(last_a, err, aborted),
               f'cd {cwd} && codex resume {sid}', {'source': src})


# ------------------------------------------------------------------ Muse

def scan_muse(path):
    sid = os.path.basename(os.path.dirname(path))
    prompts, last_a, cwd, start, end, root, model = [], '', None, None, None, None, None
    term, reason, exit_reason = None, None, None
    for line in open(path, errors='ignore'):
        if '"payload_type"' not in line: continue
        try: o = json.loads(line)
        except Exception: continue
        ts = ts_of(o.get('recorded_at'))
        pt, p = o.get('payload_type'), o.get('payload') or {}
        if pt == 'runtime.session.metadata':
            r = p.get('record') or {}; cwd = cwd or r.get('workspace_root'); model = r.get('model_id')
        elif pt == 'runtime.user_intent.accepted':
            tx = ' '.join(b.get('text', '') for b in p.get('refill_blocks') or [] if isinstance(b, dict))
            if tx.strip(): prompts.append(tx)
        elif pt == 'runtime.session':
            k = p.get('kind'); e = p.get('event') or {}
            if k == 'agent_tree_initialized':
                root = (p.get('record') or {}).get('root_session_id') == sid
            elif k == 'run':
                ek = e.get('kind')
                if ek == 'assistant_message_committed' and e.get('text'): last_a = e['text']
                elif ek == 'started' and e.get('prompt') and not prompts: prompts.append(e['prompt'])
                elif ek == 'terminal': term, reason = e.get('terminal'), e.get('reason')
        elif pt == 'session.end':
            exit_reason = (p.get('record') or {}).get('exit_reason')
        elif pt == 'session.opened.observed':
            pass
    # i tempi veri: recorded_at e' un clock logico (+1 us/record), uso mtime/ctime del file
    st = os.stat(path)
    start, end = datetime.fromtimestamp(st.st_birthtime, timezone.utc), datetime.fromtimestamp(st.st_mtime, timezone.utc)
    if not prompts: return None
    err = reason if term == 'failed' else None
    aborted = term in ('cancelled', 'interrupted')
    return rec('muse', sid, cwd, start, end, prompts, last_a, end_reason(last_a, err, aborted),
               f'cd {cwd} && muse resume {sid}', {'root': root, 'model': model, 'terminal': term,
                                                   'terminal_reason': reason, 'exit_reason': exit_reason})


# ------------------------------------------------------------------ jcode

def scan_jcode(path):
    try: d = json.load(open(path, errors='ignore'))
    except Exception: return None
    meta = d.get('meta') or {}
    msgs = d.get('messages') or []
    def text(m):
        c = m.get('content')
        if isinstance(c, list):
            return ' '.join((x.get('text') or x.get('Text') or '') for x in c if isinstance(x, dict))
        return c if isinstance(c, str) else ''
    prompts = [t for m in msgs if m.get('role') == 'user' for t in [text(m)] if t.strip() and not NOISE_RE.match(t)]
    if not prompts: return None
    last_a = next((text(m) for m in reversed(msgs) if m.get('role') == 'assistant' and text(m).strip()), '')
    cwd = d.get('working_dir') or meta.get('working_dir') or d.get('cwd')
    st = os.stat(path)
    start = ts_of(d.get('created_at') or meta.get('created_at')) or datetime.fromtimestamp(st.st_birthtime, timezone.utc)
    end = ts_of(d.get('updated_at') or meta.get('updated_at')) or datetime.fromtimestamp(st.st_mtime, timezone.utc)
    sid = os.path.basename(path)[:-5]
    return rec('jcode', sid, cwd, start, end, prompts, last_a, end_reason(last_a, None, False),
               f'jcode replay {sid}', {'title': d.get('title') or meta.get('title'),
                                       'model': d.get('model') or meta.get('model')})


# ------------------------------------------------------------------ main

def candidates(since):
    t = since.timestamp()
    def fresh(pattern):
        for p in glob.glob(pattern):
            try:
                if os.path.getmtime(p) >= t: yield p
            except OSError: pass
    for p in fresh(HOME + '/.claude/projects/*/*.jsonl'): yield ('cc', p)
    for p in fresh(HOME + '/.codex/sessions/2026/*/*/*.jsonl'): yield ('codex', p)
    for p in fresh(HOME + '/.local/share/muse/sessions/*/*/*/*/session.jsonl'): yield ('muse', p)
    for p in fresh(HOME + '/.jcode/sessions/session_*.json'): yield ('jcode', p)


def scan_one(a):
    kind, p = a
    try:
        return {'cc': scan_cc, 'codex': scan_codex, 'muse': scan_muse, 'jcode': scan_jcode}[kind](p)
    except Exception as e:
        return {'harness': kind, 'id': p, 'scan_error': repr(e)[:200]}


def find_session(sid):
    pats = [f'{HOME}/.claude/projects/*/{sid}.jsonl', f'{HOME}/.codex/sessions/2026/*/*/*{sid}.jsonl',
            f'{HOME}/.local/share/muse/sessions/*/*/*/{sid}/session.jsonl', f'{HOME}/.jcode/sessions/{sid}.json']
    for p in pats:
        hit = glob.glob(p)
        if hit: return hit[0]
    return None


def skeleton(sid, width=400):
    """Lo scheletro di una sessione: richieste e risposte in ordine, senza output dei tool.
    Costa ~1/50 del transcript: e' quello da dare a chi deve giudicare se un task e' chiuso."""
    p = find_session(sid)
    if not p: print(f'sessione {sid} non trovata'); return 1
    out = []
    if '/.claude/projects/' in p:
        for line in open(p, errors='ignore'):
            try: o = json.loads(line)
            except Exception: continue
            if o.get('type') not in ('user', 'assistant') or o.get('isMeta'): continue
            tx = cc_text((o.get('message') or {}).get('content'))
            if tx and not NOISE_RE.match(tx): out.append((o['type'][0].upper(), o.get('timestamp', '')[:16], tx))
    elif '/.codex/' in p:
        for line in open(p, errors='ignore'):
            try: o = json.loads(line)
            except Exception: continue
            pl = o.get('payload') or {}
            if o.get('type') != 'event_msg': continue
            it = pl.get('item') or {}
            c = it.get('content')
            tx = ' '.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else (c or '')
            if pl.get('type') == 'user_message': out.append(('U', o.get('timestamp', '')[:16], pl.get('message', '')))
            elif pl.get('type') == 'agent_message': out.append(('A', o.get('timestamp', '')[:16], pl.get('message', '')))
            elif it.get('type') == 'UserMessage': out.append(('U', o.get('timestamp', '')[:16], tx))
            elif it.get('type') == 'AgentMessage': out.append(('A', o.get('timestamp', '')[:16], tx))
            elif pl.get('type') in ('error', 'turn_aborted'): out.append(('!', o.get('timestamp', '')[:16], pl.get('message') or pl.get('type')))
    elif '/muse/' in p:
        for line in open(p, errors='ignore'):
            if '"payload_type"' not in line: continue
            try: o = json.loads(line)
            except Exception: continue
            pt, pl = o.get('payload_type'), o.get('payload') or {}
            if pt == 'runtime.user_intent.accepted':
                out.append(('U', '', ' '.join(b.get('text', '') for b in pl.get('refill_blocks') or [] if isinstance(b, dict))))
            elif pt == 'runtime.session' and pl.get('kind') == 'run':
                e = pl.get('event') or {}
                if e.get('kind') == 'assistant_message_committed': out.append(('A', '', e.get('text', '')))
                elif e.get('kind') == 'terminal': out.append(('!', '', f"run {e.get('terminal')}: {e.get('reason')}"))
                elif e.get('kind') == 'todo_snapshot_updated':
                    out.append(('T', '', '; '.join(f"[{i.get('status')}] {i.get('text')}" for i in e.get('items') or [])))
    else:
        d = json.load(open(p, errors='ignore'))
        for m in d.get('messages') or []:
            c = m.get('content')
            tx = ' '.join((x.get('text') or '') for x in c if isinstance(x, dict)) if isinstance(c, list) else (c or '')
            if tx.strip() and m.get('role') in ('user', 'assistant'): out.append((m['role'][0].upper(), '', tx))
    # le ripetizioni consecutive (stream, todo aggiornati) non aggiungono niente
    prev = None
    print(f'# {p}')
    for k, t, tx in out:
        key = (k, tx[:200])
        if key == prev: continue
        prev = key
        print(f'{k} {t} {clip(tx, width)}')
    return 0


# ------------------------------------------------------------------ ripresa: card sulla board Topics

TOPICS = os.environ.get('TOPICS_URL', 'https://127.0.0.1:3333')
TOPICS_CA = os.environ.get('TOPICS_CA', HOME + '/Projects/topics-app/certs/ca-cert.pem')
STATE = os.environ.get('LEDGER_STATE', HOME + '/.claude/jarvis/state/ledger')
# Board di ripiego per le sessioni nate in ~ che non toccano nessun repo con board.
# Mai registrare ~ come progetto: Topics aggiunge il path all'allowlist dei file (routes/projects.ts).
INBOX = HOME + '/.claude/jarvis/state/inbox'
PATH_RE = re.compile(r'/Users/[A-Za-z0-9_.-]+/[^\s"\'\\]+')


def topics(method, path, body=None):
    import ssl, urllib.request
    ctx = ssl.create_default_context(cafile=TOPICS_CA) if os.path.exists(TOPICS_CA) else None
    if ctx:  # Python 3.13+ rifiuta la CA di Topics (manca keyUsage): resta pinnata, senza il controllo strict
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(TOPICS + path, data=data, method=method,
                                 headers={'content-type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
        return json.loads(r.read() or b'{}')


def project_id(path):
    """Port di projectIdForPath (topics-app shared/board.ts): nome cartella + hash base36 a 6 cifre."""
    path = path.rstrip('/')
    h = 0
    for ch in path:
        h = ((h << 5) - h) + ord(ch)
        h = ((h + 2**31) % 2**32) - 2**31  # come `hash |= 0` in JS
    n, s = abs(h), ''
    while n: s = '0123456789abcdefghijklmnopqrstuvwxyz'[n % 36] + s; n //= 36
    return (path.split('/')[-1] or 'project') + '-' + (s or '0')[:6]


def all_boards():
    """L'indice di Topics (/api/all-boards/projects) non elenca subito un progetto appena registrato:
    la inbox si aggiunge a mano, con lo stesso id che userebbe il server."""
    boards = topics('GET', '/api/all-boards/projects').get('projects', [])
    if os.path.isdir(INBOX) and not any(b['path'].rstrip('/') == INBOX for b in boards):
        boards.append({'projectId': project_id(INBOX), 'name': 'inbox', 'path': INBOX})
    return boards


def board_for(row, boards):
    """La board del repo su cui la sessione ha lavorato: prefisso piu' lungo della cwd,
    altrimenti il repo con board piu' citato nei path della sessione, altrimenti inbox."""
    def match(p):
        best = None
        for b in boards:
            bp = b['path'].rstrip('/')
            if bp != HOME and (p == bp or p.startswith(bp + '/')) and (not best or len(bp) > len(best['path'])):
                best = b
        return best
    hit = match(row.get('cwd') or '')
    if hit: return hit
    path = find_session(row['id'])
    if path:
        from collections import Counter
        c = Counter()
        with open(path, errors='ignore') as f:
            for line in f:
                for p in PATH_RE.findall(line):
                    b = match(p)
                    if b: c[b['projectId']] += 1
        if c:
            top = c.most_common(1)[0][0]
            return next(b for b in boards if b['projectId'] == top)
    return next((b for b in boards if b['path'].rstrip('/') == INBOX), None)


def is_candidate(r):
    """Sessioni di lavoro morte su quota o errore API. 'interrupted' (Ctrl-C, steer) resta fuori:
    e' quasi sempre una scelta di chi scrive, non un task perso."""
    if r.get('scan_error') or r.get('end_reason') not in ('limit', 'error'): return False
    c = r.get('cwd') or ''
    if c.startswith(HOME + '/.openclaw') and c.rstrip('/') == HOME + '/.openclaw': return False  # turni di Jarvis
    if '/scratchpad' in c: return False
    return bool(r.get('first_prompt'))


def card_text(r):
    title = 'Ripresa: ' + clip(r['first_prompt'], 70)
    end = (r.get('end') or '')[:16].replace('T', ' ')
    desc = (f"Sessione {r['harness']} {r['id']} finita il {end} UTC su {r['end_reason']}: «{clip(r['last_assistant'], 160)}».\n"
            f"Cartella: {r.get('cwd')}\nUltima richiesta: {clip(r['last_prompt'], 300)}\n\n"
            f"Riprendi: `{r['resume']}`\nContesto compatto per un altro harness: "
            f"`python3 ~/.claude/jarvis/scripts/ledger/ledger.py handoff {r['id']}`\n\n"
            "Come si verifica: la barra del task originale passa (commit/PR/test); se era gia' chiuso, "
            "sposta in done con la prova nel commento.")
    return title, desc


def load_state():
    try: return json.load(open(os.path.join(STATE, 'carded.json')))
    except Exception: return {}


def sweep(days, dry):
    from datetime import timedelta
    frm = datetime.now(ROME) - timedelta(days=days)
    rows = [r for r in (scan_one(a) for a in candidates(frm)) if r]
    cands = [r for r in rows if is_candidate(r) and ts_of(r.get('end')) and ts_of(r['end']) >= frm]
    state = load_state()
    boards = all_boards()
    made = 0
    for r in cands:
        key = f"{r['harness']}:{r['id']}"
        if key in state: continue
        b = board_for(r, boards)
        title, desc = card_text(r)
        if not b:
            print(f'NESSUNA BOARD per {key} ({r.get("cwd")}): crea la board inbox su {INBOX}'); continue
        if dry:
            print(f'[dry] {b["projectId"]}: {title}'); continue
        # status esplicito: senza, Topics la mette in todo e l'auto-dispatch lancia un agente (server.mjs)
        t = topics('POST', f"/api/boards/{b['projectId']}/tasks",
                   {'text': title, 'description': desc, 'priority': 3, 'status': 'backlog'})
        state[key] = {'card': t.get('id'), 'board': b['projectId'], 'at': datetime.now(ROME).isoformat()}
        made += 1
        print(f'card {str(t.get("id"))[:8]} su {b["projectId"]}: {title}')
    if not dry:
        os.makedirs(STATE, exist_ok=True)
        tmp = os.path.join(STATE, 'carded.json.tmp')
        json.dump(state, open(tmp, 'w'), indent=1)
        os.replace(tmp, os.path.join(STATE, 'carded.json'))
    print(f'{len(cands)} sessioni morte su limite/errore negli ultimi {days} giorni, {made} card nuove')
    return 0


def check(days):
    """La barra: esce 1 se una sessione morta su limite/errore non ha la sua card viva sulla board."""
    from datetime import timedelta
    frm = datetime.now(ROME) - timedelta(days=days)
    rows = [r for r in (scan_one(a) for a in candidates(frm)) if r]
    cands = [r for r in rows if is_candidate(r) and ts_of(r.get('end')) and ts_of(r['end']) >= frm]
    state = load_state()
    # board per board: l'elenco globale salta le board che l'indice di Topics non conosce ancora
    alive = set()
    for b in {s['board'] for s in state.values()}:
        alive |= {t.get('id') for t in topics('GET', f'/api/boards/{b}/tasks').get('tasks', [])}
    bad = []
    for r in cands:
        s = state.get(f"{r['harness']}:{r['id']}")
        if not s: bad.append(f"senza card: {r['harness']}:{r['id']} {clip(r['first_prompt'], 60)}")
        elif s['card'] not in alive: bad.append(f"card sparita: {s['card']} ({r['harness']}:{r['id']})")
    cards = [s['card'] for s in state.values()]
    if len(cards) != len(set(cards)): bad.append('card doppie nello stato')
    for b in bad: print(b)
    print(f'{len(cands)} sessioni da coprire, {len(bad)} problemi')
    return 1 if bad else 0


def handoff(sid):
    """Contesto compatto (<~2k token) per riprendere su un altro harness quello che una sessione stava facendo."""
    p = find_session(sid)
    if not p: print(f'sessione {sid} non trovata'); return 1
    kind = 'cc' if '/.claude/' in p else 'codex' if '/.codex/' in p else 'muse' if '/muse/' in p else 'jcode'
    r = scan_one((kind, p))
    print(f"# Ripresa di {r['harness']} {sid}\nCartella: {r.get('cwd')}\nFinita: {r.get('end')} ({r.get('end_reason')})\n")
    print('## Richiesta iniziale\n' + clip(r['first_prompt'], 1200))
    print('\n## Ultima richiesta\n' + clip(r['last_prompt'], 800))
    print('\n## Ultima risposta\n' + clip(r['last_assistant'], 800))
    cwd = r.get('cwd')
    if cwd and os.path.isdir(cwd):
        import subprocess
        g = lambda *a: subprocess.run(['git', '-C', cwd, *a], capture_output=True, text=True).stdout.strip()
        if g('rev-parse', '--is-inside-work-tree') == 'true':
            print('\n## Git adesso\n' + g('status', '--short', '--branch')[:1500] + '\n' + g('log', '--oneline', '-8'))
    print('\nPrima di continuare: verifica sul codice cosa e\' davvero fatto, l\'ultima risposta non e\' una prova.')
    return 0


def main():
    if len(sys.argv) > 2 and sys.argv[1] in ('skeleton', 'handoff'):
        if sys.argv[1] == 'handoff': sys.exit(handoff(sys.argv[2]))
        sys.exit(skeleton(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 400))
    if len(sys.argv) > 1 and sys.argv[1] in ('sweep', 'check'):
        ap = argparse.ArgumentParser()
        ap.add_argument('cmd'); ap.add_argument('--days', type=float, default=3); ap.add_argument('--dry-run', action='store_true')
        a = ap.parse_args()
        sys.exit(sweep(a.days, a.dry_run) if a.cmd == 'sweep' else check(a.days))
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['scan'])
    ap.add_argument('--from', dest='frm', required=True)
    ap.add_argument('--to')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    frm = datetime.fromisoformat(a.frm).replace(tzinfo=ROME)
    to = datetime.fromisoformat(a.to).replace(tzinfo=ROME) if a.to else datetime.now(ROME)
    files = list(candidates(frm))
    with Pool(8) as pool:
        rows = [r for r in pool.imap_unordered(scan_one, files, chunksize=4) if r]
    keep = []
    for r in rows:
        if r.get('scan_error'): keep.append(r); continue
        e = ts_of(r.get('end'))
        if e and frm <= e <= to: keep.append(r)
    keep.sort(key=lambda r: r.get('end') or '')
    with open(a.out, 'w') as f:
        for r in keep: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    from collections import Counter
    c = Counter((r.get('harness'), r.get('klass'), r.get('end_reason')) for r in keep)
    print(f'{len(files)} file, {len(keep)} sessioni nella finestra -> {a.out}')
    for k, n in sorted(c.items(), key=lambda x: -x[1]): print(f'  {n:5d}  {k}')


if __name__ == '__main__':
    main()
