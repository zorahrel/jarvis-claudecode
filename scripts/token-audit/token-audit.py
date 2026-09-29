#!/usr/bin/env python3
"""token-audit: quanti token LLM sono passati in una finestra, e dove.

Legge i transcript di Claude Code (~/.claude/projects), le sessioni e i log di jcode,
le sessioni di Codex e OpenClaw. Non tocca niente: solo lettura.

    token-audit.py --from 2026-09-29 --to 2026-10-05 \
        [--baseline reports/baseline.md] [--out reports/settimana.md] [--brief]

Date e ore sono Europe/Rome. --to con la sola data include tutto quel giorno;
con THH:MM e' l'istante esatto (serve a rifare una baseline presa a meta' giornata).
Il report va su stdout. --out lo scrive anche su file, con in coda le metriche in JSON:
un run successivo le rilegge con --baseline e stampa il confronto in testa.
--brief stampa su stdout solo confronto, stato delle leve e qualita'; il resto sta in --out.

I dollari sono stime a listino API (con l'abbonamento Max il risparmio e' sulla quota).
"""
import argparse, base64, glob, json, os, re, statistics as st, struct, subprocess, sys, time
import tomllib
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from multiprocessing import Pool
from zoneinfo import ZoneInfo

ROME = ZoneInfo('Europe/Rome')
HOME = os.path.expanduser('~')
CC_ROOT = os.path.join(HOME, '.claude', 'projects')
# Claude Code nomina la cartella di progetto col percorso, '/' -> '-'
HOME_SLUG = HOME.replace('/', '-')
HOME_MEMORY = os.path.join(CC_ROOT, HOME_SLUG, 'memory', 'MEMORY.md')
HOME_AGENTS = os.path.join(HOME, 'AGENTS.md')
METRICS_TAG = '<!-- token-audit-metrics '
TOK = 3.5  # caratteri per token, stima per i tool result


# ---------------------------------------------------------------- formato e prezzi

def fmt(n):
    n = float(n)
    if abs(n) >= 1e9: return f'{n/1e9:.2f}B'
    if abs(n) >= 1e6: return f'{n/1e6:.1f}M'
    if abs(n) >= 1e3: return f'{n/1e3:.1f}k'
    return f'{n:.0f}'


def price(model):
    """$/MTok: (input, write5m, write1h, read, output)."""
    m = (model or '').lower()
    if 'fable-5-1' in m or 'mythos-5-1' in m: return (10, 12.5, 20, 0.25, 50)
    if 'fable' in m or 'mythos' in m: return (10, 12.5, 20, 1.0, 50)
    if 'opus' in m: return (5, 6.25, 10, 0.5, 25)
    if 'sonnet-5' in m: return (2, 2.5, 4, 0.2, 10)
    if 'sonnet' in m: return (3, 3.75, 6, 0.3, 15)
    if 'haiku' in m: return (1, 1.25, 2, 0.1, 5)
    return (5, 6.25, 10, 0.5, 25)


def legacy(model):  # prezzi "Opus classico", solo per la colonna di confronto
    m = (model or '').lower()
    if 'sonnet' in m: return (3, 3.75, 3.75, 0.3, 15)
    if 'haiku' in m: return (1, 1.25, 1.25, 0.1, 5)
    return (15, 18.75, 18.75, 1.5, 75)


def cost(c, pf=price):
    p = pf(c['model']); cc5 = c['cc'] - c['cc1h']
    return (c['inp'] * p[0] + cc5 * p[1] + c['cc1h'] * p[2] + c['cr'] * p[3] + c['out'] * p[4]) / 1e6


def split_cost(c):
    p = price(c['model']); cc5 = c['cc'] - c['cc1h']
    return dict(inp=c['inp'] * p[0] / 1e6, cw=(cc5 * p[1] + c['cc1h'] * p[2]) / 1e6,
                cr=c['cr'] * p[3] / 1e6, out=c['out'] * p[4] / 1e6)


def q(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))] if v else 0


def dist(v):
    v = sorted(v)
    if not v: return 'n/a'
    return f"n={len(v)} p10 {fmt(q(v, .1))} · mediana {fmt(q(v, .5))} · p90 {fmt(q(v, .9))} · max {fmt(v[-1])}"


def med(v):
    return st.median(v) if v else 0


def medm(v):
    # per le metriche salvate: senza campioni è «n/d», non 0 (0 si leggerebbe −100%)
    return st.median(v) if v else None


# ---------------------------------------------------------------- scansione Claude Code

def pts(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def img_tokens(b64):
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return 1600
    d = None
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        d = struct.unpack('>II', raw[16:24])
    elif raw[:2] == b'\xff\xd8':
        i = 2
        while i < len(raw) - 9:
            if raw[i] != 0xFF:
                i += 1; continue
            m = raw[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack('>HH', raw[i + 5:i + 9]); d = (w, h); break
            ln = struct.unpack('>H', raw[i + 2:i + 4])[0]; i += 2 + ln
    if not d:
        return 1600
    w, h = d
    s = min(1.0, 1568 / max(w, h)); w, h = w * s, h * s
    if w * h > 1_150_000:
        k = (1_150_000 / (w * h)) ** 0.5; w, h = w * k, h * k
    return int(w * h / 750)


def desc_of(name, inp):
    if not isinstance(inp, dict): return ''
    if name == 'Read':
        s = inp.get('file_path', '')
        if inp.get('offset') or inp.get('limit'): s += f" [{inp.get('offset')}:{inp.get('limit')}]"
        return s
    if name in ('Edit', 'Write', 'NotebookEdit'): return inp.get('file_path', '')
    if name == 'Bash': return (inp.get('command') or '')[:140].replace('\n', ' ')
    if name == 'Grep': return f"{inp.get('pattern')} @ {inp.get('path', '')} mode={inp.get('output_mode', '')}"
    if name == 'Glob': return f"{inp.get('pattern')} @ {inp.get('path', '')}"
    if name in ('Agent', 'Task'): return f"{inp.get('subagent_type', '')}: {inp.get('description', '')}"
    if name == 'WebFetch': return inp.get('url', '')
    return json.dumps(inp, ensure_ascii=False)[:140]


def result_len(c):
    chars, imgs = 0, []
    cont = c.get('content')
    if isinstance(cont, str):
        chars = len(cont)
    elif isinstance(cont, list):
        for b in cont:
            t = b.get('type')
            if t == 'text': chars += len(b.get('text', ''))
            elif t == 'image': imgs.append((b.get('source') or {}).get('data', ''))
            else: chars += len(json.dumps(b))
    return chars, imgs


def scan(job):
    """Un transcript -> chiamate API, tool result, compattazioni, attachment dentro la finestra."""
    path, start, end = job
    rel = os.path.relpath(path, CC_ROOT)
    parts = rel.split(os.sep)
    is_sub = 'subagents' in parts
    agent_type = ''
    if is_sub:
        try: agent_type = json.load(open(path[:-6] + '.meta.json')).get('agentType', '')
        except Exception: agent_type = '?'
    calls, results, compacts = [], [], []
    attach = Counter(); attach_first = {}; sys_subtypes = Counter(); entry_points = Counter()
    snapshot_len = instr_files = queue_prompt = first_user_text = None
    user_imgs = []; tool_uses = {}; reads = defaultdict(list); seen_mid = {}; live = []
    errors = Counter()
    ncalls = 0; prev = None; compact_since = False
    try: fh = open(path, 'rb')
    except Exception: return None
    for line in fh:
        try: d = json.loads(line)
        except Exception: continue
        typ = d.get('type'); ts = d.get('timestamp') or ''
        if ts and ts >= end:
            continue  # oltre la finestra: niente conta
        inwin = ts >= start
        if typ == 'assistant':
            m = d.get('message') or {}
            for b in m.get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    nm = b.get('name', '')
                    tool_uses[b.get('id')] = (nm, desc_of(nm, b.get('input')))
                    if nm == 'Read' and inwin:
                        reads[(b.get('input') or {}).get('file_path', '')].append(b.get('id'))
            model = m.get('model', '')
            if model == '<synthetic>':
                # messaggi d'errore scritti dalla CLI: qui si vede la compattazione che va in loop
                if inwin and d.get('isApiErrorMessage'):
                    txt = ' '.join(x.get('text', '') for x in m.get('content') or [] if isinstance(x, dict))
                    if txt.startswith('Autocompact is thrashing'): errors['thrashing'] += 1
                    elif txt.startswith('Prompt is too long'): errors['prompt_too_long'] += 1
                    else: errors['altro'] += 1
                continue
            mid = m.get('id') or d.get('requestId'); u = m.get('usage')
            if not u or mid in seen_mid: continue
            seen_mid[mid] = 1
            if d.get('entrypoint'): entry_points[d['entrypoint']] += 1
            if not inwin:
                prev = (pts(ts), model, (u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0))
                continue
            inp = u.get('input_tokens') or 0; cc = u.get('cache_creation_input_tokens') or 0
            cr = u.get('cache_read_input_tokens') or 0; out = u.get('output_tokens') or 0
            cc1h = (u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens') or 0
            ctx = inp + cc + cr; t = pts(ts); bust = None
            # bust = la cache e' stata riscritta: read crolla rispetto al contesto di prima
            if prev is not None and not compact_since and prev[2] > 20000 and cr < 0.5 * prev[2] and cc > 10000:
                gap = (t - prev[0]) if (t and prev[0]) else 0
                bust = ('model_switch' if model != prev[1] else 'idle>1h' if gap > 3600
                        else 'idle5m-1h' if gap > 300 else 'other(<5m)')
            calls.append(dict(mid=mid, ts=ts, t=t, model=model, inp=inp, cc=cc, cc1h=cc1h, cr=cr, out=out, ctx=ctx,
                              bust=bust, bust_gap=(t - prev[0]) if (bust and t and prev and prev[0]) else None,
                              ep=d.get('entrypoint', ''), idx=ncalls, effort=d.get('effort')))
            ncalls += 1; prev = (t, model, ctx); compact_since = False
        elif typ == 'user':
            m = d.get('message') or {}; cont = m.get('content')
            if d.get('isCompactSummary'): continue
            if first_user_text is None and inwin:
                if isinstance(cont, str): first_user_text = cont[:200]
                elif isinstance(cont, list):
                    for b in cont:
                        if isinstance(b, dict) and b.get('type') == 'text':
                            first_user_text = b.get('text', '')[:200]; break
            if not isinstance(cont, list) or not inwin: continue
            for b in cont:
                if not isinstance(b, dict): continue
                if b.get('type') == 'tool_result':
                    chars, imgs = result_len(b); tid = b.get('tool_use_id')
                    nm, ds = tool_uses.get(tid, ('?', ''))
                    results.append(dict(tid=tid, name=nm, desc=ds, chars=chars, nimg=len(imgs),
                                        img_tok=sum(img_tokens(x) for x in imgs), ts=ts, carried_calls=0))
                    live.append((len(results) - 1, ncalls))
                elif b.get('type') == 'image':
                    user_imgs.append(img_tokens((b.get('source') or {}).get('data', '')))
        elif typ == 'system':
            stp = d.get('subtype'); sys_subtypes[stp] += 1
            if stp == 'compact_boundary' and inwin:
                cm = d.get('compactMetadata') or {}
                compacts.append(dict(uuid=d.get('uuid'), ts=ts, trigger=cm.get('trigger'), pre=cm.get('preTokens')))
                for ri, c0 in live: results[ri]['carried_calls'] = ncalls - c0
                live = []; compact_since = True
        elif typ == 'attachment':
            a = d.get('attachment') or {}; at = a.get('type')
            if inwin: attach[at] += len(json.dumps(a, ensure_ascii=False))
            if at == 'prompt_snapshot' and snapshot_len is None:
                sp = a.get('systemPrompt')
                snapshot_len = sum(len(x) for x in sp) if isinstance(sp, list) else len(str(sp))
            if at == 'instructions' and instr_files is None:
                instr_files = [(f.get('path'), len(f.get('content') or '')) for f in a.get('files') or []]
            if at not in attach_first and inwin: attach_first[at] = len(json.dumps(a, ensure_ascii=False))
        elif typ == 'queue-operation' and queue_prompt is None and inwin:
            c = d.get('content')
            if isinstance(c, str): queue_prompt = c[:200]
    fh.close()
    for ri, c0 in live: results[ri]['carried_calls'] = ncalls - c0
    tid2res = {r['tid']: r for r in results}
    read_stats = []
    for p, tids in reads.items():
        if len(tids) >= 2:
            ch = [tid2res[x]['chars'] for x in tids if x in tid2res]
            read_stats.append((p, len(tids), sum(ch), ch[0] if ch else 0))
    if not calls and not results and not compacts and not errors:
        return None
    return dict(path=rel, project=parts[0], is_sub=is_sub, agent_type=agent_type, calls=calls, results=results,
                compacts=compacts, attach=dict(attach), attach_first=attach_first, sys_subtypes=dict(sys_subtypes),
                entry=entry_points.most_common(1)[0][0] if entry_points else '', snapshot_len=snapshot_len,
                instr_files=instr_files, user_imgs=user_imgs, read_stats=read_stats, errors=dict(errors),
                queue_prompt=queue_prompt, first_user_text=first_user_text)


def scan_all(start_iso, end_iso, start_epoch, workers):
    files = []
    for p in glob.glob(os.path.join(CC_ROOT, '**', '*.jsonl'), recursive=True):
        try: s = os.stat(p)
        except Exception: continue
        if s.st_mtime >= start_epoch: files.append((s.st_size, p))
    files.sort(reverse=True)
    t0 = time.time()
    with Pool(workers) as pool:
        recs = [r for r in pool.imap_unordered(scan, [(p, start_iso, end_iso) for _, p in files], chunksize=4) if r]
    print(f'scan: {len(files)} file, {sum(s for s, _ in files)/1e9:.1f} GB, {len(recs)} con dati, {time.time()-t0:.0f}s', file=sys.stderr)
    return recs


# ---------------------------------------------------------------- analisi Claude Code

def klass(r):
    p = r['project']
    if r['is_sub']: return 'subagent'
    if p.startswith(HOME_SLUG + '--topics-worktrees'): return 'topics-board-worktree'
    if p.startswith(HOME_SLUG + '--openclaw'): return 'openclaw(cron/gtm)'
    if p.startswith(HOME_SLUG + '--claude-jarvis'): return 'jarvis-router'
    if p.startswith('-private-') or p.startswith(HOME_SLUG + '--jcode-scratch') or 'scratch-workspaces' in p:
        return 'tmp/probe/scratch'
    return 'progetti/home'


def short(p):
    return p.replace(HOME, '~').replace(HOME_SLUG, '~')


class Report:
    def __init__(self):
        self.lines = []

    def __call__(self, *a):
        self.lines.append(' '.join(str(x) for x in a))


def analyze_cc(recs, P, M, day):
    # dedup: fork e resume copiano i messaggi, una chiamata conta una volta
    allc = []
    for r in recs:
        for c in r['calls']:
            c['file'] = r['path']; c['rec'] = r; allc.append(c)
    allc.sort(key=lambda c: (c['ts'], c['file']))
    seen = set(); calls = []; dup_by_file = Counter()
    for c in allc:
        if c['mid'] in seen: dup_by_file[c['file']] += 1; continue
        seen.add(c['mid']); calls.append(c)
    P(f"Chiamate API uniche (Claude Code): {len(calls)} · duplicate scartate (fork/resume copiati): {len(allc)-len(calls)} · file transcript con dati: {len(recs)}\n")
    P("Prezzi ($/MTok, listino API, stima): Opus 5/5.5 in 5 · write5m 6.25 · write1h 10 · read 0.50 · out 25. Sonnet 5: 2/2.5/4/0.2/10. 'legacy' = Opus 15/18.75/1.5/75.\n")
    if not calls:
        P('Nessuna chiamata nella finestra.'); return None
    tot = Counter()
    for c in calls:
        for k in ('inp', 'cc', 'cc1h', 'cr', 'out'): tot[k] += c[k]
        tot['usd'] += cost(c); tot['usd_legacy'] += cost(c, legacy)
        for k, v in split_cost(c).items(): tot['usd_' + k] += v
    allin = tot['inp'] + tot['cc'] + tot['cr']
    M.update(cc_calls=len(calls), cc_usd=tot['usd'], cc_cache_read=tot['cr'], cc_cache_write=tot['cc'],
             cc_output=tot['out'], cc_input_side=allin, cc_usd_per_call=tot['usd'] / len(calls),
             cc_ctx_per_call=allin / len(calls))
    P('## Totali')
    P(f"input {fmt(tot['inp'])} · cache write {fmt(tot['cc'])} (di cui 1h {fmt(tot['cc1h'])}) · cache read {fmt(tot['cr'])} · output {fmt(tot['out'])} · totale input-side {fmt(allin)}")
    P(f"Costo stimato: ${tot['usd']:.0f} (legacy ${tot['usd_legacy']:.0f}) — di cui input ${tot['usd_inp']:.0f}, cache write ${tot['usd_cw']:.0f}, cache read ${tot['usd_cr']:.0f}, output ${tot['usd_out']:.0f}")
    P(f"Cache hit ratio (read / input-side): {tot['cr']/allin:.3f} · costo medio per chiamata ${tot['usd']/len(calls):.3f} · contesto medio {fmt(allin/len(calls))}\n")

    def table(title, keyf, top=None):
        agg = defaultdict(Counter)
        for c in calls:
            a = agg[keyf(c)]
            for f in ('inp', 'cc', 'cr', 'out'): a[f] += c[f]
            a['usd'] += cost(c); a['n'] += 1
        rows = sorted(agg.items(), key=lambda kv: -kv[1]['usd'])[:top]
        P(f'## {title}')
        P('| chiave | chiamate | input | cache write | cache read | output | $ stimati | hit |')
        P('|---|---|---|---|---|---|---|---|')
        for k, a in rows:
            ai = a['inp'] + a['cc'] + a['cr']
            P(f"| {k} | {a['n']} | {fmt(a['inp'])} | {fmt(a['cc'])} | {fmt(a['cr'])} | {fmt(a['out'])} | {a['usd']:.0f} | {a['cr']/ai if ai else 0:.2f} |")
        P('')
        return agg

    table('Per giorno', lambda c: day(c['ts']))
    table('Per modello', lambda c: c['model'])
    table('Per progetto (top 12)', lambda c: short(c['rec']['project']), top=12)
    cls = table('Per classe di sessione', lambda c: klass(c['rec']))
    for k, a in cls.items():
        M[f"class_usd[{k}]"] = a['usd']
    table('Per entrypoint', lambda c: c['ep'] or '?')
    table('Per effort', lambda c: str(c.get('effort')))

    # ---- subagent per tipo
    P('## Subagent per agentType')
    sa = defaultdict(Counter)
    for c in calls:
        if c['rec']['is_sub']:
            a = sa[c['rec']['agent_type']]; a['usd'] += cost(c); a['n'] += 1; a['tok'] += c['inp'] + c['cc'] + c['cr'] + c['out']
    nfiles = Counter(r['agent_type'] for r in recs if r['is_sub'] and r['calls'])
    P('| agentType | run | chiamate | token | $ |'); P('|---|---|---|---|---|')
    for k, a in sorted(sa.items(), key=lambda kv: -kv[1]['usd'])[:15]:
        P(f"| {k} | {nfiles[k]} | {a['n']} | {fmt(a['tok'])} | {a['usd']:.0f} |")
    P('')

    # ---- sessioni
    byfile = defaultdict(list)
    for c in calls: byfile[c['file']].append(c)
    sess = []
    for r in recs:
        cs = byfile.get(r['path'], [])
        if not cs: continue
        fresh = cs[0]['idx'] == 0 and dup_by_file[r['path']] == 0
        sess.append(dict(path=r['path'], klass=klass(r), n=len(cs), first_ctx=cs[0]['ctx'] if fresh else None,
                         max_ctx=max(c['ctx'] for c in cs), usd=sum(cost(c) for c in cs), cc=sum(c['cc'] for c in cs),
                         cr=sum(c['cr'] for c in cs), inp=sum(c['inp'] for c in cs), rec=r, calls=cs,
                         model=Counter(c['model'] for c in cs).most_common(1)[0][0],
                         big_usd=sum(cost(c) for c in cs if c['ctx'] > 200000)))

    P('## Contesto al primo turno (sessioni nate nella finestra)')
    for k in sorted(set(s['klass'] for s in sess)):
        v = [s['first_ctx'] for s in sess if s['klass'] == k and s['first_ctx']]
        P(f"- {k}: {dist(v)}")
        M[f"first_ctx_p50[{k}]"] = medm(v)
    v = [s['first_ctx'] for s in sess if s['first_ctx'] and s['klass'] != 'subagent']
    P(f"- TUTTE le principali: {dist(v)}"); M['first_ctx_p50[principali]'] = medm(v)
    bd = defaultdict(list)
    for s in sess:
        if s['first_ctx'] and s['klass'] != 'subagent': bd[day(s['calls'][0]['ts'])].append(s['first_ctx'])
    P('- mediana per giorno: ' + ' · '.join(f"{d} {fmt(st.median(x))}" for d, x in sorted(bd.items())))
    P(f"- system prompt (prompt_snapshot, caratteri): {dist([r['snapshot_len'] for r in recs if r['snapshot_len']])}")
    instr = Counter(); instr_n = Counter()
    for r in recs:
        for p, n in r['instr_files'] or []:
            instr[p] = max(instr[p], n); instr_n[p] += 1
    P('- file di istruzioni iniettati (max caratteri · n sessioni): ' + ' · '.join(f"{short(p)} {fmt(n)}c×{instr_n[p]}" for p, n in instr.most_common(8)))
    M['home_memory_injected_chars'] = instr.get(HOME_MEMORY, 0)
    M['home_memory_sessions'] = instr_n.get(HOME_MEMORY, 0)
    M['home_agents_md_sessions'] = instr_n.get(HOME_AGENTS, 0)
    att = Counter()
    for r in recs:
        for k, v2 in r['attach'].items(): att[k] += v2
    P('- attachment totali nella finestra (caratteri, tutte le sessioni): ' + ' · '.join(f"{k} {fmt(v2)}" for k, v2 in att.most_common(12)))
    P('')

    # ---- cache busting
    P('## Cache busting (chiamate con read < 50% del contesto precedente e write > 10k, esclusi post-compact)')
    bc = defaultdict(Counter)
    for c in calls:
        if c['bust']:
            p = price(c['model']); cc5 = c['cc'] - c['cc1h']
            rewrite = (cc5 * p[1] + c['cc1h'] * p[2]) / 1e6
            a = bc[c['bust']]; a['n'] += 1; a['cc'] += c['cc']; a['usd'] += rewrite; a['avoid'] += rewrite - c['cc'] * p[3] / 1e6
    P('| causa | eventi | token riscritti | $ write | $ evitabili (write−read) |'); P('|---|---|---|---|---|')
    for k, a in sorted(bc.items(), key=lambda kv: -kv[1]['cc']):
        P(f"| {k} | {a['n']} | {fmt(a['cc'])} | {a['usd']:.0f} | {a['avoid']:.0f} |")
    tw = sum(c['cc'] for c in calls) or 1
    P(f"Cache write totale {fmt(tw)}: busting = {sum(a['cc'] for a in bc.values())/tw:.1%}")
    P(f"Scritture cache con TTL 1h: {sum(c['cc1h'] for c in calls)/tw:.1%} (costano 2× input contro 1.25× del 5m)")
    bk = defaultdict(Counter)
    for c in calls:
        if c['bust']: bk[klass(c['rec'])][c['bust']] += c['cc']
    P('Per classe: ' + ' · '.join(f"{k}: " + ', '.join(f"{b} {fmt(x)}" for b, x in bb.most_common()) for k, bb in bk.items()))
    P('\nSessioni con write/read più alto (>=2M token input-side):')
    ws = sorted([s for s in sess if s['cc'] + s['cr'] + s['inp'] > 2e6], key=lambda s: -s['cc'] / max(1, s['cr']))
    for s in ws[:10]:
        P(f"- {s['path'][:90]} · {s['klass']} · write {fmt(s['cc'])} / read {fmt(s['cr'])} · {s['n']} chiamate · busts {sum(1 for c in s['calls'] if c['bust'])} · ${s['usd']:.0f}")
    P('')

    # ---- crescita contesto e compattazioni (leva autoCompactWindow)
    P('## Crescita contesto e compattazioni')
    for th in (200e3, 400e3, 500e3, 800e3):
        ss = [s for s in sess if s['max_ctx'] > th]
        P(f"- sessioni con contesto > {fmt(th)}: {len(ss)} (principali {sum(1 for s in ss if s['klass']!='subagent')}) · costo totale di queste sessioni ${sum(s['usd'] for s in ss):.0f}")
        M[f'sessions_gt{int(th/1e3)}k'] = len(ss)
        M[f'sessions_gt{int(th/1e3)}k_usd'] = sum(s['usd'] for s in ss)
    for th in (200e3, 400e3):
        big = [c for c in calls if c['ctx'] > th]
        P(f"- chiamate con contesto > {fmt(th)}: {len(big)} ({len(big)/len(calls):.1%}) · cache read {fmt(sum(c['cr'] for c in big))} · costo ${sum(cost(c) for c in big):.0f} ({sum(cost(c) for c in big)/tot['usd']:.1%} del totale)")
        M[f'calls_gt{int(th/1e3)}k_share'] = len(big) / len(calls)
        M[f'calls_gt{int(th/1e3)}k_usd_share'] = sum(cost(c) for c in big) / tot['usd']
    for th in (100e3, 200e3, 400e3):
        ex = sum(max(0, c['ctx'] - th) for c in calls)
        exu = sum(max(0, c['cr'] - th) * price(c['model'])[3] / 1e6 for c in calls)
        P(f"- token input-side oltre soglia {fmt(th)} per chiamata: {fmt(ex)} (≈ ${exu:.0f} solo in cache read)")
        M[f'tokens_over_{int(th/1e3)}k'] = ex
    comp = {}
    for r in recs:
        for x in r['compacts']: comp[x['uuid']] = (x, r)
    trig = Counter(x['trigger'] for x, _ in comp.values())
    pre = [x['pre'] for x, _ in comp.values() if x['pre']]
    pre1m = [p for p in pre if p > 250e3]  # finestre da 1M: prima scattavano a ~667k, con autoCompactWindow 433000 a ~413k
    P(f"- compattazioni: {len(comp)} ({dict(trig)}) · preTokens {dist(pre)} · per classe {dict(Counter(klass(r) for _, r in comp.values()))}")
    P(f"- compattazioni su finestre da 1M (preTokens > 250k): {dist(pre1m)}")
    M.update(compactions=len(comp), compactions_auto=trig.get('auto', 0), compact_pre_p50=medm(pre),
             compactions_1m=len(pre1m), compact_pre_1m_p50=medm(pre1m))
    errs = Counter()
    for r in recs: errs.update(r['errors'])
    P(f"- errori della CLI nella finestra: thrashing della compattazione {errs['thrashing']} · prompt troppo lungo {errs['prompt_too_long']} · altri {errs['altro']}")
    for r in recs:
        if r['errors'].get('thrashing'): P(f"  - thrashing in {r['path'][:110]} ×{r['errors']['thrashing']}")
    M.update(thrashing_errors=errs['thrashing'], prompt_too_long_errors=errs['prompt_too_long'])
    P('Top 10 sessioni per costo:')
    for s in sorted(sess, key=lambda s: -s['usd'])[:10]:
        P(f"- ${s['usd']:.0f} · {s['path'][:95]} · {s['klass']} · {s['model']} · {s['n']} chiamate · max ctx {fmt(s['max_ctx'])} · quota >200k ${s['big_usd']:.0f}")
    P('')

    # ---- tool result
    res = {}
    for r in recs:
        m0 = (byfile.get(r['path']) or [{'model': 'claude-opus-5-5'}])[0]['model']
        for x in r['results']:
            if x['tid'] not in res:
                x['file'] = r['path']; x['rec'] = r; x['model'] = m0; res[x['tid']] = x
    P(f'## Tool result (caratteri; token stimati = caratteri/{TOK} + immagini)')
    P('Colonna "portati" = token del risultato × chiamate successive nella stessa sessione fino a compact/fine → volume di cache read che quel risultato genera.')
    tg = defaultdict(Counter)
    for x in res.values():
        n = x['name'] if not x['name'].startswith('mcp__') else 'mcp__' + x['name'].split('__')[1] + '__*'
        a = tg[n]; a['n'] += 1; a['chars'] += x['chars']; a['img'] += x['nimg']
        t = x['chars'] / TOK + x['img_tok']; a['tok'] += t; a['carried'] += t * x['carried_calls']
        a['carried_usd'] += t * x['carried_calls'] * price(x['model'])[3] / 1e6
    P('| tool | n | caratteri | token | portati (cache read) | $ read portati | img |'); P('|---|---|---|---|---|---|---|')
    for k, a in sorted(tg.items(), key=lambda kv: -kv[1]['carried'])[:20]:
        P(f"| {k} | {a['n']} | {fmt(a['chars'])} | {fmt(a['tok'])} | {fmt(a['carried'])} | {a['carried_usd']:.0f} | {a['img']} |")
    P(f"Totale tool result: {fmt(sum(a['chars'] for a in tg.values()))} caratteri, {fmt(sum(a['tok'] for a in tg.values()))} token, portati {fmt(sum(a['carried'] for a in tg.values()))}")
    M['tool_result_carried_tokens'] = sum(a['carried'] for a in tg.values())
    P('\nTop 15 singoli risultati:')
    for x in sorted(res.values(), key=lambda x: -x['chars'])[:15]:
        P(f"- {fmt(x['chars'])}c · {x['name']} · {short(x['desc'])[:110]} · portato {x['carried_calls']}× · {x['file'][:60]}")
    bands = Counter(); bandc = Counter()
    for x in res.values():
        b = '<2k' if x['chars'] < 2000 else '2-10k' if x['chars'] < 10000 else '10-30k' if x['chars'] < 30000 else '30-100k' if x['chars'] < 100000 else '>100k'
        bands[b] += 1; bandc[b] += x['chars']
    P('Fasce: ' + ' · '.join(f"{b}: {bands[b]} risultati, {fmt(bandc[b])}c" for b in ('<2k', '2-10k', '10-30k', '30-100k', '>100k')))
    P('')

    # ---- immagini
    P('## Immagini')
    ni = sum(x['nimg'] for x in res.values()); it = sum(x['img_tok'] for x in res.values())
    itc = sum(x['img_tok'] * x['carried_calls'] for x in res.values())
    ui = [t for r in recs for t in r['user_imgs']]
    P(f"- nei tool result: {ni} immagini ≈ {fmt(it)} token, portate {fmt(itc)} token di cache read")
    P(f"- incollate nei messaggi utente: {len(ui)} ≈ {fmt(sum(ui))} token")
    itool = Counter(); itoolt = Counter()
    for x in res.values():
        if x['nimg']: itool[x['name']] += x['nimg']; itoolt[x['name']] += x['img_tok'] * max(1, x['carried_calls'])
    P('- per tool (n · token portati): ' + ' · '.join(f"{k} {v2} · {fmt(itoolt[k])}" for k, v2 in itool.most_common(8)))
    P('')

    # ---- letture ripetute
    P('## Read ripetuti nella stessa sessione (>=3 volte lo stesso file)')
    rr = [(n, ch, f, p, r['path']) for r in recs for p, n, ch, f in r['read_stats'] if n >= 3]
    P(f"- casi: {len(rr)} · letture in eccesso (oltre la prima): {sum(n-1 for n, *_ in rr)} · caratteri in eccesso {fmt(sum(ch - f for n, ch, f, *_ in rr))}")
    P(f"- tutti i Read ripetuti (>=2): letture in eccesso {sum(n - 1 for r in recs for p, n, ch, f in r['read_stats'])}, caratteri {fmt(sum(ch - f for r in recs for p, n, ch, f in r['read_stats']))}")
    for n, ch, f, p, fp in sorted(rr, key=lambda t: -t[1])[:10]:
        P(f"- {n}× {short(p)} · {fmt(ch)}c · {fp[:60]}")
    P('')

    # ---- headless / router / cron
    P('## Sessioni headless / router / cron')
    for k in ('jarvis-router', 'openclaw(cron/gtm)', 'topics-board-worktree', 'tmp/probe/scratch', 'progetti/home', 'subagent'):
        ss = [s for s in sess if s['klass'] == k]
        if not ss: continue
        one = [s for s in ss if s['n'] <= 3]
        P(f"- {k}: {len(ss)} sessioni · {sum(s['n'] for s in ss)} chiamate · ${sum(s['usd'] for s in ss):.0f} · mediana chiamate/sessione {st.median([s['n'] for s in ss]):.0f} · startup {dist([s['first_ctx'] for s in ss if s['first_ctx']])} · sessioni ≤3 chiamate: {len(one)} (${sum(s['usd'] for s in one):.0f})")
    P('Costo del solo primo turno (write della cache di avvio) per classe:')
    for k in sorted(set(s['klass'] for s in sess)):
        ss = [s for s in sess if s['klass'] == k and s['first_ctx']]
        u = sum(cost(s['calls'][0]) for s in ss)
        P(f"- {k}: {len(ss)} avvii · ${u:.0f} · medio ${u/max(1,len(ss)):.3f}")
    qp = Counter()
    for r in recs:
        if klass(r) in ('openclaw(cron/gtm)', 'jarvis-router'):
            qp[(r['queue_prompt'] or r['first_user_text'] or '')[:70].replace('\n', ' ')] += 1
    P('Prompt più frequenti nelle sessioni openclaw/jarvis: ' + ' | '.join(f"{n}× {t}" for t, n in qp.most_common(6)))
    P('')
    P('## Sottotipi system visti: ' + str(sum((Counter(r['sys_subtypes']) for r in recs), Counter()).most_common(12)))
    P('')
    return dict(calls=calls, byfile=byfile, sess=sess, res=res, tot=tot)


def deep_cc(recs, cc, P, M):
    """Approfondimenti: Bash, immagini, subagent, istruzioni statiche, OpenClaw, one-shot, composizione avvio."""
    calls, byfile, sess, res = cc['calls'], cc['byfile'], cc['sess'], cc['res']
    P('# Approfondimenti')
    P('## Bash per categoria di comando')

    def bcat(d):
        m = re.match(r'(?:cd [^&;]+(?:&&|;)\s*)?(?:[A-Z_]+=\S+\s+)*(\S+)(?:\s+(\S+))?', d.strip())
        if not m: return '?'
        a, b = m.group(1).split('/')[-1], m.group(2) or ''
        if a in ('git', 'bun', 'npm', 'npx', 'pnpm', 'gh'): return a + ' ' + b
        return a
    bc = defaultdict(Counter)
    bb = [x for x in res.values() if x['name'] == 'Bash']
    for x in bb:
        a = bc[bcat(x['desc'])]; a['n'] += 1; a['ch'] += x['chars']; a['carr'] += x['chars'] / TOK * x['carried_calls']; a['big'] += x['chars'] >= 10000
    P('```')
    for k, a in sorted(bc.items(), key=lambda kv: -kv[1]['carr'])[:22]:
        P(f"{k[:28]:28s} n={a['n']:6d} chars={fmt(a['ch']):>7s} carried={fmt(a['carr']):>7s} >=10k:{a['big']}")
    P('```')
    if bb:
        sc = sorted(x['chars'] for x in bb)
        P(f"Bash chars p50/p90/p99: {q(sc,.5)} {q(sc,.9)} {q(sc,.99)} · risultati >=29k caratteri: {sum(1 for x in bb if x['chars'] >= 29000)}")
    big = [x for x in bb if x['chars'] >= 10000]
    P(f"Bash >=10k: {len(big)} risultati, {fmt(sum(x['chars'] for x in big))} caratteri, portati {fmt(sum(x['chars']/TOK*x['carried_calls'] for x in big))} (≈ ${sum(x['chars']/TOK*x['carried_calls']*0.5/1e6 for x in big):.0f} in read)")
    bk = Counter(); bkn = Counter()
    for x in bb: bk[klass(x['rec'])] += x['chars'] / TOK * x['carried_calls']; bkn[klass(x['rec'])] += 1
    P('Bash portati per classe: ' + ' · '.join(f"{k} {fmt(v)} ({bkn[k]} risultati)" for k, v in bk.most_common()))
    # tokenjuice comprime l'output di exec di OpenClaw: qui si vede se l'output Bash di OpenClaw si e' accorciato
    ob = sorted(x['chars'] for x in bb if klass(x['rec']) == 'openclaw(cron/gtm)')
    P(f"Bash in OpenClaw: {len(ob)} risultati · caratteri p50 {q(ob,.5)} · p90 {q(ob,.9)} · totale {fmt(sum(ob))} · portati {fmt(bk['openclaw(cron/gtm)'])}")
    M.update(openclaw_bash_results=len(ob), openclaw_bash_chars=sum(ob), openclaw_bash_chars_p90=q(ob, .9),
             openclaw_bash_carried=bk['openclaw(cron/gtm)'])
    P('')

    P('## Read con immagini: percorsi')
    ipc = Counter(); ip = Counter(); ik = Counter()
    for x in res.values():
        if x['name'] == 'Read' and x['nimg']:
            d0 = re.sub(r'/[^/]*$', '/', x['desc'].split(' [')[0])
            ip[d0] += x['nimg']; ipc[d0] += x['img_tok'] * max(1, x['carried_calls']); ik[klass(x['rec'])] += x['nimg']
    P('per classe ' + str(dict(ik)))
    for p, n in ipc.most_common(10): P(f"  {fmt(n)} portati · {ip[p]} img · {short(p)[:110]}")
    tr = [x for x in res.values() if x['name'] == 'Read' and '/tool-results/' in x['desc']]
    P(f"Read di tool-results persistiti: {len(tr)} letture, {fmt(sum(x['chars'] for x in tr))} caratteri, portati {fmt(sum(x['chars']/TOK*x['carried_calls'] for x in tr))}")
    P('')

    # ---- subagent: primo turno per tipo (leve worker e verifier snelli)
    P('## Subagent: costo e primo turno per tipo')
    sp = defaultdict(Counter)
    for c in calls:
        r = c['rec']
        if r['is_sub']:
            k = r['path'].split('/')[0] + '/' + r['path'].split('/')[1][:8]; sp[k]['usd'] += cost(c); sp[k]['n'] += 1
    P('sessioni padre più care: ' + ' · '.join(f"{k} ${a['usd']:.0f}" for k, a in sorted(sp.items(), key=lambda kv: -kv[1]['usd'])[:6]))
    for at in ('worker', 'verifier', 'workflow-subagent', 'general-purpose', 'scout', 'oracle'):
        fs = [f for f, cs in byfile.items() if cs[0]['rec']['is_sub'] and cs[0]['rec']['agent_type'] == at]
        if not fs: continue
        ncalls = [len(byfile[f]) for f in fs]; mx = [max(c['ctx'] for c in byfile[f]) for f in fs]
        us = [sum(cost(c) for c in byfile[f]) for f in fs]; fc = [byfile[f][0]['ctx'] for f in fs if byfile[f][0]['idx'] == 0]
        P(f"- {at}: run {len(fs)} · chiamate/run med {med(ncalls):.0f} p90 {q(ncalls,.9)} · maxctx med {fmt(med(mx))} p90 {fmt(q(mx,.9))} · >200k {sum(1 for m in mx if m > 200e3)} · $/run med {med(us):.2f} p90 {q(us,.9):.2f} · primo turno med {fmt(med(fc))} · modello {Counter(byfile[f][0]['model'] for f in fs).most_common(2)}")
        M[f'sub_first_ctx_p50[{at}]'] = medm(fc); M[f'sub_runs[{at}]'] = len(fs); M[f'sub_usd_per_run_p50[{at}]'] = medm(us)
    h = defaultdict(Counter)
    for c in calls: h[klass(c['rec'])]['cc'] += c['cc']; h[klass(c['rec'])]['h'] += c['cc1h']
    P('quota write 1h per classe: ' + str({k: f"{a['h']/max(1,a['cc']):.0%}" for k, a in h.items()}))
    P('')

    # ---- istruzioni statiche (leve ~/AGENTS.md, MEMORY.md, verifier senza CLAUDE.md)
    P('## Istruzioni statiche per classe (attachment instructions)')
    agg = defaultdict(Counter)
    for r in recs:
        cs = byfile.get(r['path'], [])
        if not cs: continue
        a = agg[klass(r)]; a['files'] += 1
        if r['instr_files']:
            a['with'] += 1; d = dict(r['instr_files']); totc = sum(d.values()); a['chars'] += totc
            a['carried'] += totc / TOK * len(cs)
            a['usd'] += sum(totc / TOK * price(c['model'])[3] / 1e6 for c in cs)
            if HOME_AGENTS in d:
                a['agents'] += 1; a['agents_carried'] += d[HOME_AGENTS] / TOK * len(cs)
            for p, n in d.items():
                if p.endswith('MEMORY.md'):
                    a['mem_carried'] += n / TOK * len(cs); a['mem_usd'] += sum(n / TOK * price(c['model'])[3] / 1e6 for c in cs)
    for k, a in agg.items():
        P(f"- {k}: file {a['files']} · con istruzioni {a['with']} · media {fmt(a['chars']/max(1,a['with']))}c · portati {fmt(a['carried'])} (${a['usd']:.0f}) · con ~/AGENTS.md {a['agents']} (portati {fmt(a['agents_carried'])}) · MEMORY.md portati {fmt(a['mem_carried'])} (${a['mem_usd']:.0f})")
    M['instr_carried_tokens'] = sum(a['carried'] for a in agg.values())
    M['memory_carried_tokens'] = sum(a['mem_carried'] for a in agg.values())
    M['agents_md_carried_tokens'] = sum(a['agents_carried'] for a in agg.values())
    vr = [sum(n for _, n in (r['instr_files'] or [])) for r in recs if r['is_sub'] and r['agent_type'] == 'verifier' and byfile.get(r['path'])]
    P(f"- verifier: caratteri di istruzioni per run {dist(vr)}")
    M['verifier_instr_chars_p50'] = medm(vr)
    P('')

    # ---- one-shot di Topics (sdk-cli dalla home, poche chiamate): la memoria automatica e' spenta?
    P('## One-shot dalla home (sdk-cli, ≤3 chiamate)')
    one = []
    for r in recs:
        cs = byfile.get(r['path'], [])
        if klass(r) == 'progetti/home' and r['project'] == HOME_SLUG and r['entry'] == 'sdk-cli' and 0 < len(cs) <= 3:
            one.append((r, cs))
    withmem = [r for r, _ in one if any(p == HOME_MEMORY for p, _ in (r['instr_files'] or []))]
    fc = [cs[0]['ctx'] for r, cs in one if cs[0]['idx'] == 0]
    P(f"- sessioni {len(one)} · con l'indice MEMORY.md {len(withmem)} · primo turno {dist(fc)} · ${sum(cost(c) for _, cs in one for c in cs):.0f}")
    kinds = Counter((r['queue_prompt'] or r['first_user_text'] or '')[:50].replace('\n', ' ') for r, _ in one)
    P('- prompt più frequenti: ' + ' | '.join(f"{n}× {t}" for t, n in kinds.most_common(5)))
    M.update(oneshot_sessions=len(one), oneshot_with_memory=len(withmem), oneshot_first_ctx_p50=medm(fc))
    P('')

    # ---- OpenClaw per tipo di prompt
    P('## OpenClaw per tipo di prompt')
    og = defaultdict(Counter)
    for r in recs:
        if klass(r) != 'openclaw(cron/gtm)': continue
        cs = byfile.get(r['path'], [])
        if not cs: continue
        t = r['queue_prompt'] or r['first_user_text'] or ''
        k = ('heartbeat' if 'heartbeat' in t.lower() else 'cron' if t.startswith('[cron:') else 'inter-session' if 'Inter-session' in t
             else 'discord/chat ctx' if 'Conversation info' in t or 'openclaw:ctx' in t else 'resume' if 'resumed this CLI' in t else 'altro')
        a = og[k]; a['s'] += 1; a['n'] += len(cs); a['usd'] += sum(cost(c) for c in cs); a['first'] += cs[0]['ctx']; a['comp'] += len(r['compacts'])
        a['short'] += len(cs) <= 5
    for k, a in sorted(og.items(), key=lambda kv: -kv[1]['usd']):
        P(f"- {k}: sessioni {a['s']} · chiamate {a['n']} · ${a['usd']:.0f} · avvio medio {fmt(a['first']/a['s'])} · compact {a['comp']} · ≤5 chiamate {a['short']}")
    P('- modelli: ' + str(Counter(c['model'] for f, cs in byfile.items() for c in cs if klass(cs[0]['rec']) == 'openclaw(cron/gtm)').most_common()))
    P('')

    # ---- composizione dell'avvio
    P('## Composizione avvio (primo turno, token) — mediana')
    comp = defaultdict(lambda: defaultdict(list))
    for r in recs:
        cs = byfile.get(r['path'], [])
        if not cs or cs[0]['idx'] != 0: continue
        k = klass(r)
        if k == 'progetti/home': k = 'progetti/home:' + (r['entry'] or '?')
        if k == 'subagent': k = 'subagent:' + (r['agent_type'] or '?')
        att = sum(v for kk, v in r['attach_first'].items() if kk not in ('prompt_snapshot', 'hook_success', 'deferred_tools_record'))
        comp[k]['first'].append(cs[0]['ctx']); comp[k]['sys'].append((r['snapshot_len'] or 0) / TOK); comp[k]['att'].append(att / TOK)
    for k, d in sorted(comp.items(), key=lambda kv: -len(kv[1]['first'])):
        if len(d['first']) < 3: continue
        f = med(d['first']); s = med(d['sys']); a = med(d['att'])
        P(f"- {k}: n={len(d['first'])} · primo turno {fmt(f)} · system prompt ~{fmt(s)} · attachment ~{fmt(a)} · resto (schemi tool/MCP, messaggio) ~{fmt(max(0, f-s-a))}")
    P('')


# ---------------------------------------------------------------- workflow e gauntlet

RN_DESC = re.compile(r'r(\d+)')
RN_LABEL = re.compile(r'(?:^|[:\-_ ])r(\d+)(?=$|[:\-_ ])|pr\d+r(\d+)')
ISSUE_KEYS = ('issues', 'blockers', 'blocking', 'problems', 'findings', 'newDefects', 'defects', 'wrong', 'missing', 'regressions')


def verdict(res):
    """Esito di un verifier dal suo risultato strutturato: (PASS|FAIL|?, difetti)."""
    if res is None: return 'MISSING', []
    if isinstance(res, str):
        try: res = json.loads(res)
        except Exception: return 'TEXT', []
    if not isinstance(res, dict): return '?', []
    iss = []
    for k in ISSUE_KEYS:
        v = res.get(k)
        if isinstance(v, list): iss += v
    if 'pass' in res: s = 'PASS' if res['pass'] else 'FAIL'
    elif 'refuted' in res: s = 'FAIL' if res['refuted'] else 'PASS'
    elif 'ok' in res: s = 'PASS' if res['ok'] else 'FAIL'
    elif 'blockers' in res: s = 'FAIL' if res['blockers'] else 'PASS'
    elif 'newDefects' in res: s = 'FAIL' if res['newDefects'] else 'PASS'
    else: s = '?'
    return s, iss


def analyze_workflows(recs, cc, P, M):
    calls, byfile = cc['calls'], cc['byfile']
    P('## Workflow (gauntlet: worker + verifier per round)')
    wf = defaultdict(Counter); wp = defaultdict(Counter)
    for c in calls:
        r = c['rec']
        if r['is_sub'] and '/workflows/' in r['path']:
            a = wf[r['agent_type']]; a['usd'] += cost(c); a['tok'] += c['inp'] + c['cc'] + c['cr'] + c['out']; a['n'] += 1
            p = r['path'].split('/'); k = p[0][:45] + '/' + p[1][:8]; wp[k]['usd'] += cost(c); wp[k]['tok'] += c['cr'] + c['cc']
    for k, a in sorted(wf.items(), key=lambda kv: -kv[1]['usd']): P(f"- {k}: {a['n']} chiamate · {fmt(a['tok'])} token · ${a['usd']:.0f}")
    tw = sum(a['usd'] for a in wf.values()); tall = sum(cost(c) for c in calls) or 1
    P(f"- totale workflow: {fmt(sum(a['tok'] for a in wf.values()))} token · ${tw:.0f} ({tw/tall:.0%} del totale Claude Code)")
    M.update(wf_usd=tw, wf_share=tw / tall)
    for k, a in sorted(wp.items(), key=lambda kv: -kv[1]['usd'])[:5]: P(f"  - {k}: ${a['usd']:.0f} · {fmt(a['tok'])}")

    # journal e meta per ogni agente di workflow nella finestra
    jcache = {}
    rows = []
    for r in recs:
        if not (r['is_sub'] and '/workflows/' in r['path'] and byfile.get(r['path'])): continue
        full = os.path.join(CC_ROOT, r['path']); wdir = os.path.dirname(full)
        aid = os.path.basename(full)[len('agent-'):-len('.jsonl')]
        if wdir not in jcache:
            started, results = {}, {}
            try:
                for l in open(os.path.join(wdir, 'journal.jsonl')):
                    try: e = json.loads(l)
                    except Exception: continue
                    if e.get('type') == 'started': started[e.get('agentId')] = e.get('label')
                    elif e.get('type') == 'result': results[e.get('agentId')] = e.get('result')
            except Exception: pass
            jcache[wdir] = (started, results)
        started, results = jcache[wdir]
        try: desc = json.load(open(full[:-6] + '.meta.json')).get('description', '')
        except Exception: desc = ''
        label = started.get(aid) or desc or ''
        m1 = RN_DESC.search(desc); m2 = RN_LABEL.search(label)
        rows.append(dict(wf=os.path.relpath(wdir, CC_ROOT), type=r['agent_type'], label=label,
                         round_desc=int(m1.group(1)) if m1 else 1,
                         round=int(m2.group(1) or m2.group(2)) if m2 else None,
                         res=results.get(aid), usd=sum(cost(c) for c in byfile[r['path']]),
                         tok=sum(c['cr'] + c['cc'] for c in byfile[r['path']])))
    vr = defaultdict(Counter)
    for x in rows:
        if x['type'] == 'verifier':
            k = 'r1' if x['round_desc'] <= 1 else 'r2' if x['round_desc'] == 2 else 'r3+'
            vr[k]['n'] += 1; vr[k]['usd'] += x['usd']; vr[k]['tok'] += x['tok']
    P('- verifier nei workflow per round (dalla descrizione): ' + ' · '.join(f"{k}: {a['n']} run, {fmt(a['tok'])} token, ${a['usd']:.0f}" for k, a in sorted(vr.items())))
    for k in ('r1', 'r2', 'r3+'):
        M[f'wf_verifier_runs[{k}]'] = vr[k]['n']; M[f'wf_verifier_usd[{k}]'] = vr[k]['usd']

    # qualita': catene di verifica per pezzo, round per round (dal label: verify:<pezzo>:r2, fix-r3, ...)
    chains = defaultdict(list)
    for x in rows:
        if x['type'] == 'verifier' and x['round'] is not None:
            chains[(x['wf'], RN_LABEL.sub(':R', x['label']))].append(x)
    runs = Counter(); fails = Counter(); issues = Counter(); esc = 0; oos = 0; usd_r2 = []
    maxr = []
    for key, lst in chains.items():
        maxr.append(max(x['round'] for x in lst))
        for x in lst:
            k = 'r1' if x['round'] <= 1 else 'r2' if x['round'] == 2 else 'r3+'
            s, iss = verdict(x['res'])
            runs[k] += 1; fails[k] += s == 'FAIL'; issues[k] += len(iss)
            if x['round'] >= 2:
                usd_r2.append(x['usd'])
                res = x['res'] if isinstance(x['res'], dict) else {}
                if isinstance(res.get('regressions'), list) and res['regressions']: esc += 1
                if isinstance(res.get('outOfScope'), list): oos += len(res['outOfScope'])
    P(f"- catene di verifica (pezzo per pezzo, round nel label): {len(chains)} · arrivate a r2 {sum(1 for m in maxr if m >= 2)} · a r3+ {sum(1 for m in maxr if m >= 3)}")
    for k in ('r1', 'r2', 'r3+'):
        P(f"  - {k}: {runs[k]} run · FAIL {fails[k]} · difetti segnalati {issues[k]}")
    P(f"  - da r2: escalation (il fix ha rotto qualcosa) {esc} · note fuori claim {oos} · $/run verifier da r2 mediana {med(usd_r2):.2f}")
    M.update(chains=len(chains), chains_r2=sum(1 for m in maxr if m >= 2), chains_r3=sum(1 for m in maxr if m >= 3),
             escalations=esc, out_of_scope_notes=oos, verifier_r2plus_usd_p50=medm(usd_r2))
    for k in ('r1', 'r2', 'r3+'):
        M[f'chain_runs[{k}]'] = runs[k]; M[f'chain_fail[{k}]'] = fails[k]; M[f'chain_defects[{k}]'] = issues[k]
    long_ = [(k, lst) for k, lst in chains.items() if max(x['round'] for x in lst) >= 3]
    for (w, pc), lst in sorted(long_, key=lambda kv: kv[0])[:12]:
        seq = ' → '.join(f"r{x['round']} {verdict(x['res'])[0]}({len(verdict(x['res'])[1])})" for x in sorted(lst, key=lambda x: x['round']))
        P(f"  - {w.split('/')[1][:8]} {pc[:50]}: {seq}")
    P('')


# ---------------------------------------------------------------- jcode, Codex, OpenClaw

def analyze_jcode(start_iso, end_iso, start_epoch, P, M, t_from, t_to):
    J = os.path.join(HOME, '.jcode', 'sessions')
    seen = set(); agg = defaultdict(Counter); first = {}; per_sess = defaultdict(list); sess_model = {}

    def add(sid, m, model):
        u = m.get('token_usage'); ts = m.get('timestamp') or ''
        if not u or ts < start_iso or ts >= end_iso: return
        k = (sid, m.get('id'))
        if k in seen: return
        seen.add(k)
        i = u.get('input_tokens') or 0; cc = u.get('cache_creation_input_tokens') or 0
        cr = u.get('cache_read_input_tokens') or 0; o = u.get('output_tokens') or 0
        a = agg[model]; a['n'] += 1; a['in'] += i; a['cc'] += cc; a['cr'] += cr; a['out'] += o
        ctx = i + cc + cr
        usd = (i * 5 + cc * 6.25 + cr * 0.5 + o * 25) / 1e6 if 'claude' in (model or '') else 0
        per_sess[sid].append((ts, ctx, usd, model))
        if sid not in first or ts < first[sid][0]: first[sid] = (ts, ctx)
    for p in glob.glob(J + '/session_*.json') + glob.glob(J + '/session_*.journal.jsonl'):
        if os.path.getmtime(p) < start_epoch: continue
        sid = os.path.basename(p).split('.')[0]
        try:
            if p.endswith('.jsonl'):
                for l in open(p, errors='replace'):
                    d = json.loads(l); model = (d.get('meta') or {}).get('model') or sess_model.get(sid, '?'); sess_model[sid] = model
                    for m in d.get('append_messages') or []: add(sid, m, model)
            else:
                d = json.load(open(p)); model = d.get('model') or '?'; sess_model[sid] = model
                for m in d.get('messages') or []: add(sid, m, model)
        except Exception:
            pass
    P('## jcode (~/.jcode/sessions)')
    T = Counter()
    for k, a in sorted(agg.items(), key=lambda kv: -kv[1]['cr']):
        P(f"- {k}: {a['n']} chiamate · input non-cache {fmt(a['in'])} · write {fmt(a['cc'])} · read {fmt(a['cr'])} · out {fmt(a['out'])}")
        T.update(a)
    ai = T['in'] + T['cc'] + T['cr']
    P(f"- totale: {T['n']} chiamate, input-side {fmt(ai)}, hit {T['cr']/max(1,ai):.2f}, input NON in cache {fmt(T['in'])} ({T['in']/max(1,ai):.1%})")
    fc = sorted(v[1] for v in first.values() if v[1] > 0)
    if fc: P(f"- avvio: {len(fc)} sessioni, mediana {fmt(q(fc,.5))}, p90 {fmt(q(fc,.9))}")
    usd = (T['in'] * 5 + T['cc'] * 6.25 + T['cr'] * 0.5 + T['out'] * 25) / 1e6
    P(f"- $ stimati (prezzi Opus 5, write come 5m): {usd:.0f}")
    turns = [t for v in per_sess.values() for t in v if 'claude' in (t[3] or '')]
    ctxs = [t[1] for t in turns]
    M.update(jcode_calls=T['n'], jcode_input_side=ai, jcode_usd=usd, jcode_ctx_p50=q(ctxs, .5), jcode_ctx_p90=q(ctxs, .9),
             jcode_ctx_max=max(ctxs) if ctxs else 0)
    if ctxs:
        P(f"- contesto per chiamata (Claude): n {len(ctxs)} · mediana {fmt(q(ctxs,.5))} · p90 {fmt(q(ctxs,.9))} · max {fmt(max(ctxs))}")
        for thr in (400e3, 500e3):
            above = [t for t in turns if t[1] > thr]; ss = {s for s, v in per_sess.items() for t in v if t[1] > thr}
            P(f"  - >{fmt(thr)}: chiamate {len(above)} ({len(above)/len(turns):.1%}) · sessioni {len(ss)} (costo totale ${sum(t[2] for s in ss for t in per_sess[s]):.0f}) · token oltre soglia {fmt(sum(t[1]-thr for t in above))}")
            M[f'jcode_calls_gt{int(thr/1e3)}k'] = len(above); M[f'jcode_sessions_gt{int(thr/1e3)}k'] = len(ss)
            M[f'jcode_sessions_gt{int(thr/1e3)}k_usd'] = sum(t[2] for s in ss for t in per_sess[s])
    # compattazioni dai log: normali (compaction_complete) e d'emergenza (hard compact: tiene 10 messaggi, riassunto senza LLM)
    comp = []; hard = []
    d0 = t_from.date()
    while d0 <= t_to.date():
        f = os.path.join(HOME, '.jcode', 'logs', f'jcode-{d0:%Y-%m-%d}.log')
        d0 += timedelta(days=1)
        if not os.path.exists(f): continue
        for l in open(f, errors='replace'):
            if 'compaction_complete:' not in l and 'ard compact' not in l and 'auto-compacted and retrying' not in l: continue
            try: t = datetime.strptime(l[1:20], '%Y-%m-%d %H:%M:%S').replace(tzinfo=ROME)
            except Exception: continue
            if not (t_from <= t < t_to): continue
            if 'compaction_complete:' in l:
                m = re.search(r'pre_tokens=(\d+), post_tokens=(\d+)', l)
                sm = re.search(r'ses:session_([a-z]+)', l)
                comp.append((t, int(m.group(1)) if m else 0, int(m.group(2)) if m else 0, sm.group(1) if sm else '?'))
            elif 'Hard compact dropped' in l or 'auto-compacted and retrying' in l:
                sm = re.search(r'ses:session_([a-z]+)', l); hard.append((t, sm.group(1) if sm else '?', l.strip()[-120:]))
    P(f"- compattazioni (log): {len(comp)} · pre_tokens {dist([c[1] for c in comp])} · d'emergenza (hard compact) {len(hard)}")
    for t, sname, tail in hard[:10]: P(f"  - hard {t:%m-%d %H:%M} {sname}: {tail}")
    M.update(jcode_compactions=len(comp), jcode_compact_pre_p50=medm([c[1] for c in comp]), jcode_hard_compactions=len(hard))
    P('')


def analyze_codex_openclaw(start_iso, end_iso, start_epoch, P, M):
    P('## Codex (~/.codex/sessions)')
    C = Counter(); models = Counter(); nsess = 0
    for p in glob.glob(os.path.join(HOME, '.codex/sessions/*/*/*/*.jsonl')):
        if os.path.getmtime(p) < start_epoch: continue
        model = '?'; last = None; used = False
        for l in open(p, errors='replace'):
            try: d = json.loads(l)
            except Exception: continue
            pl = d.get('payload') or {}
            if d.get('type') == 'turn_context': model = pl.get('model', model)
            ts = d.get('timestamp') or ''
            if pl.get('type') == 'token_count' and start_iso <= ts < end_iso:
                info = pl.get('info') or {}; tt = info.get('total_token_usage')
                if tt and tt != last:
                    lu = info.get('last_token_usage') or {}
                    C['in'] += lu.get('input_tokens', 0); C['cached'] += lu.get('cached_input_tokens', 0); C['out'] += lu.get('output_tokens', 0)
                    C['n'] += 1; models[model] += 1; used = True; last = tt
        nsess += used
    P(f"- {nsess} sessioni · {C['n']} chiamate · input {fmt(C['in'])} (di cui cached {fmt(C['cached'])}) · output {fmt(C['out'])} · modelli {dict(models)}")
    M.update(codex_calls=C['n'], codex_input=C['in'])
    P('')
    P('## OpenClaw (~/.openclaw/agents/*/sessions)')
    O = Counter(); prov = Counter(); n = 0
    s_ms, e_ms = pts(start_iso + 'Z') * 1000, pts(end_iso + 'Z') * 1000
    for p in glob.glob(os.path.join(HOME, '.openclaw/agents/*/sessions/*')):
        if os.path.getmtime(p) < start_epoch or os.path.isdir(p): continue
        try:
            raw = subprocess.run(['zstd', '-dc', p], capture_output=True).stdout if p.endswith('.zst') else open(p, 'rb').read()
        except Exception:
            continue
        for l in raw.splitlines():
            try: d = json.loads(l)
            except Exception: continue
            m = d.get('message') or {}; u = m.get('usage')
            if u and isinstance(m.get('timestamp'), (int, float)) and s_ms <= m['timestamp'] < e_ms:
                O['n'] += 1; O['cr'] += u.get('cacheRead', 0); O['cw'] += u.get('cacheWrite', 0); O['out'] += u.get('output', 0)
                prov[(m.get('provider'), m.get('model'))] += 1
        n += 1
    P(f"- {n} file · {O['n']} risposte con usage · read {fmt(O['cr'])} · write {fmt(O['cw'])} · out {fmt(O['out'])} · provider {dict(prov)} (backend claude-cli: i token sono gia' nei transcript Claude Code di OpenClaw)")
    P('')


# ---------------------------------------------------------------- stato delle leve (letto adesso, non nella finestra)

def lever_state(P):
    P('## Stato delle leve adesso')
    try:
        s = json.load(open(os.path.join(HOME, '.claude', 'settings.json')))
        P(f"- Claude Code autoCompactWindow: {s.get('autoCompactWindow', 'non impostato (default)')}")
    except Exception as e:
        P(f'- Claude Code settings.json illeggibile: {e}')
    try:
        c = tomllib.load(open(os.path.join(HOME, '.jcode', 'config.toml'), 'rb'))
        P(f"- jcode [compaction] max_context_tokens: {(c.get('compaction') or {}).get('max_context_tokens', 'non impostato')}")
    except Exception as e:
        P(f'- jcode config.toml illeggibile: {e}')
    ag = os.path.join(HOME, '.claude', 'agents')
    w = os.path.exists(os.path.join(ag, 'worker.md'))
    try: v = 'omitClaudeMd: true' in open(os.path.join(ag, 'verifier.md')).read()
    except Exception: v = False
    P(f"- agente worker: {'presente' if w else 'ASSENTE'} · verifier con omitClaudeMd: {'sì' if v else 'no'}")
    P(f"- ~/AGENTS.md: {'PRESENTE (doppione caricato nelle sessioni dalla home)' if os.path.lexists(HOME_AGENTS) else 'assente'}")
    try:
        t = open(HOME_MEMORY).read()
        P(f"- indice memoria della home: {len(t.splitlines())} righe, {len(t)} caratteri (tetto agents-doctor 150 righe / 20000)")
    except Exception:
        P('- indice memoria della home: non trovato')
    # tokenjuice: plugin di OpenClaw che comprime l'output di exec
    try:
        raw = open(os.path.join(HOME, '.openclaw', 'openclaw.json')).read()
        tj = 'tokenjuice' in raw
        hit = []

        def walk(o, path=''):
            if isinstance(o, dict):
                for k, x in o.items():
                    if 'tokenjuice' in k.lower() and isinstance(x, dict): hit.append((path + k, x.get('enabled')))
                    walk(x, path + k + '.')
            elif isinstance(o, list):
                for x in o: walk(x, path)
        try: walk(json.loads(raw))
        except Exception: pass
        P(f"- tokenjuice in openclaw.json: {'sì ' + str(hit) if tj else 'no'}")
    except Exception:
        P('- openclaw.json non leggibile')
    # tool MCP di OpenClaw: senza la patch openclaw-mcp-lazy gli schemi viaggiano in ogni chiamata.
    # Il daemon (skill_workshop, un tool solo) resta alwaysLoad apposta: non conta.
    try:
        chk = os.path.expanduser('~/.claude/jarvis/scripts/openclaw-mcp-lazy/openclaw-mcp-lazy.py')
        r = subprocess.run([chk, 'check'], capture_output=True, text=True, timeout=30)
        ver = subprocess.run(['openclaw', '--version'], capture_output=True, text=True, timeout=20).stdout.strip().splitlines()
        P(f"- {ver[0] if ver else 'OpenClaw ?'}: {(r.stdout or r.stderr).strip()}")
    except Exception as e:
        P(f'- OpenClaw: stato della patch openclaw-mcp-lazy non leggibile: {e}')
    P('')


# ---------------------------------------------------------------- confronto con una baseline

# (chiave, etichetta, 'vol' = si normalizza per giorno | 'lvl' = livello, atteso)
COMPARE = [
    ('Volume e costo', [
        ('cc_calls', 'chiamate Claude Code', 'vol', ''),
        ('cc_usd', '$ Claude Code', 'vol', '↓'),
        ('cc_usd_per_call', '$ per chiamata', 'lvl', '↓'),
        ('cc_ctx_per_call', 'contesto medio per chiamata', 'lvl', '↓'),
        ('cc_cache_read', 'cache read', 'vol', '↓'),
    ]),
    ('Leva autoCompactWindow 433000 (Claude Code compatta a ~400k)', [
        ('sessions_gt400k', 'sessioni >400k', 'vol', '↓'),
        ('sessions_gt400k_usd', '$ delle sessioni >400k', 'vol', '↓'),
        ('sessions_gt500k', 'sessioni >500k', 'vol', '↓'),
        ('calls_gt400k_share', 'quota chiamate >400k', 'lvl', '↓'),
        ('tokens_over_400k', 'token oltre 400k', 'vol', '↓'),
        ('calls_gt200k_usd_share', 'quota costo chiamate >200k', 'lvl', '↓'),
    ]),
    ('Leva jcode max_context_tokens 500000', [
        ('jcode_usd', '$ jcode', 'vol', '↓'),
        ('jcode_ctx_p90', 'contesto p90 jcode', 'lvl', '↓'),
        ('jcode_calls_gt400k', 'chiamate jcode >400k', 'vol', '↓'),
        ('jcode_sessions_gt400k_usd', '$ sessioni jcode >400k', 'vol', '↓'),
    ]),
    ('Leve worker e verifier snelli (primo turno)', [
        ('sub_first_ctx_p50[worker]', 'primo turno worker', 'lvl', '< workflow-subagent'),
        ('sub_first_ctx_p50[workflow-subagent]', 'primo turno workflow-subagent', 'lvl', ''),
        ('sub_runs[worker]', 'run worker', 'vol', '↑ (al posto dei workflow-subagent)'),
        ('sub_runs[workflow-subagent]', 'run workflow-subagent', 'vol', '↓'),
        ('sub_first_ctx_p50[verifier]', 'primo turno verifier', 'lvl', '↓'),
        ('verifier_instr_chars_p50', 'caratteri istruzioni per verifier', 'lvl', '↓ ~0'),
        ('wf_usd', '$ workflow', 'vol', '↓'),
    ]),
    ('Leve istruzioni fisse (~/AGENTS.md via, MEMORY.md potato, one-shot senza memoria)', [
        ('home_agents_md_sessions', 'sessioni che caricano ~/AGENTS.md', 'vol', '↓ 0'),
        ('home_memory_injected_chars', 'MEMORY.md della home iniettato (caratteri max)', 'lvl', '↓'),
        ('memory_carried_tokens', 'token MEMORY.md portati', 'vol', '↓'),
        ('oneshot_with_memory', 'one-shot con MEMORY.md', 'vol', '↓ 0'),
        ('oneshot_first_ctx_p50', 'primo turno one-shot', 'lvl', '↓'),
        ('first_ctx_p50[principali]', 'primo turno sessioni principali', 'lvl', '↓'),
    ]),
    ('OpenClaw (tokenjuice e tool MCP a richiesta, se tenuti)', [
        ('first_ctx_p50[openclaw(cron/gtm)]', 'primo turno OpenClaw', 'lvl', '↓ se lazy-load'),
        ('openclaw_bash_chars_p90', 'output exec OpenClaw p90 (caratteri)', 'lvl', '↓ se tokenjuice'),
        ('openclaw_bash_carried', 'output exec OpenClaw portati', 'vol', '↓ se tokenjuice'),
        ('class_usd[openclaw(cron/gtm)]', '$ OpenClaw', 'vol', '↓'),
    ]),
    ('Qualità: si è perso qualcosa?', [
        ('thrashing_errors', 'errori «Autocompact is thrashing»', 'vol', '= 0'),
        ('prompt_too_long_errors', 'errori «Prompt is too long»', 'vol', '='),
        ('compactions_1m', 'compattazioni su finestre 1M', 'vol', '↑ atteso'),
        ('compact_pre_1m_p50', 'preTokens mediana finestre 1M', 'lvl', '↓ ~413k'),
        ('jcode_compactions', 'compattazioni jcode', 'vol', '↑ atteso'),
        ('jcode_hard_compactions', "compattazioni d'emergenza jcode", 'vol', '= 0'),
        ('chains', 'catene di verifica', 'vol', ''),
        ('chains_r3', 'catene arrivate a r3+', 'vol', '↓'),
        ('chain_fail[r2]', 'verifier r2 FAIL', 'vol', ''),
        ('chain_defects[r2]', 'difetti trovati a r2', 'vol', 'non crollare'),
        ('chain_defects[r3+]', 'difetti trovati a r3+', 'vol', 'non crollare'),
        ('escalations', 'escalation (fix che rompe)', 'vol', 'nuovo'),
        ('verifier_r2plus_usd_p50', '$ per verifier da r2 (mediana)', 'lvl', '↓'),
    ]),
]


def compare(M, B, P):
    bd, nd = B.get('window_days') or 1, M.get('window_days') or 1
    P(f"## Confronto con la baseline {B.get('from')} → {B.get('to')} ({bd:.2f} giorni) — questa finestra {nd:.2f} giorni")
    P("I volumi ('vol') sono per giorno, così finestre di lunghezza diversa si confrontano; i livelli ('lvl') sono mediane o quote.")
    for title, rows in COMPARE:
        P(f'### {title}')
        P('| metrica | baseline | adesso | Δ | atteso |'); P('|---|---|---|---|---|')
        for key, label, kind, exp in rows:
            b, n = B.get(key), M.get(key)
            if b is None and n is None: continue
            if kind == 'vol':
                bv = None if b is None else b / bd; nv = None if n is None else n / nd; unit = '/g'
            else:
                bv, nv, unit = b, n, ''

            def f(x):
                if x is None: return 'n/d'
                if 'share' in key: return f'{x:.1%}'
                if 'usd' in key and kind == 'lvl': return f'${x:.2f}'
                if abs(x) < 10 and x != int(x): return f'{x:.2f}{unit}'
                return fmt(x) + unit
            dlt = f"{(nv - bv) / bv:+.0%}" if (bv not in (None, 0) and nv is not None) else ('nuovo' if bv in (None, 0) and nv else '—')
            P(f'| {label} | {f(bv)} | {f(nv)} | {dlt} | {exp} |')
        P('')


def read_metrics(path):
    for l in open(path):
        if l.startswith(METRICS_TAG):
            return json.loads(l[len(METRICS_TAG):].rsplit('-->', 1)[0])
    sys.exit(f'{path}: nessun blocco metriche (va scritto da token-audit.py --out)')


# ---------------------------------------------------------------- main

def parse_when(s, end=False):
    if 'T' in s:
        return datetime.fromisoformat(s).replace(tzinfo=ROME)
    d = datetime.fromisoformat(s).replace(tzinfo=ROME)
    return d + timedelta(days=1) if end else d


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--from', dest='frm', required=True, help='YYYY-MM-DD[THH:MM], Europe/Rome')
    ap.add_argument('--to', required=True, help='YYYY-MM-DD (giorno incluso) o YYYY-MM-DDTHH:MM (istante)')
    ap.add_argument('--baseline', help='report scritto prima con --out: stampa il confronto in testa')
    ap.add_argument('--out', help='scrive anche qui il report, con le metriche JSON in coda')
    ap.add_argument('--brief', action='store_true', help='su stdout solo confronto, leve e qualità')
    ap.add_argument('--workers', type=int, default=8)
    a = ap.parse_args()
    t_from, t_to = parse_when(a.frm), parse_when(a.to, end=True)
    if t_to <= t_from: sys.exit('--to deve venire dopo --from')
    start_iso = t_from.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    end_iso = t_to.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    start_epoch = t_from.timestamp()

    def day(ts):
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(ROME).strftime('%m-%d')

    recs = scan_all(start_iso, end_iso, start_epoch, a.workers)
    M = dict(**{'from': t_from.strftime('%Y-%m-%d %H:%M'), 'to': t_to.strftime('%Y-%m-%d %H:%M')},
             window_days=(t_to - t_from).total_seconds() / 86400, generated=datetime.now(ROME).strftime('%Y-%m-%d %H:%M'))
    head, body, quality = Report(), Report(), Report()
    head(f"# Uso token LLM, {t_from:%d/%m %H:%M} → {t_to:%d/%m %H:%M} (Europe/Rome, {M['window_days']:.2f} giorni)\n")
    cc = analyze_cc(recs, body, M, day)
    if cc:
        analyze_workflows(recs, cc, quality, M)
        deep_cc(recs, cc, body, M)
    analyze_jcode(start_iso, end_iso, start_epoch, quality, M, t_from, t_to)
    analyze_codex_openclaw(start_iso, end_iso, start_epoch, body, M)
    lever_state(head)
    if a.baseline:
        compare(M, read_metrics(a.baseline), head)
    body('# Note metodo')
    body('- Chiamate Claude Code deduplicate per message.id; bust = read < 50% del contesto precedente e write > 10k, esclusi i turni dopo una compattazione.')
    body('- Token dei tool result = caratteri/3.5; "portati" = token × chiamate successive fino a compattazione o fine sessione.')
    body('- OpenClaw usa il backend claude-cli: i suoi token sono già nei transcript Claude Code di ~/.openclaw. Codex: solo volumi. jcode: store proprio, sommato a parte.')
    body('- Catene di verifica: agenti verifier nei workflow con il round nel label (verify:<pezzo>:r2, fix-r3…); FAIL e difetti letti dal risultato strutturato nel journal.')
    full = '\n'.join(head.lines + quality.lines + body.lines) + '\n'
    print('\n'.join(head.lines + quality.lines) + '\n' if a.brief else full, end='')
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, 'w') as f:
            f.write(full + METRICS_TAG + json.dumps(M, ensure_ascii=False, default=float) + ' -->\n')
        print(f'report scritto in {a.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
