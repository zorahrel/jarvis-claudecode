#!/usr/bin/env python3
"""Richiamo dinamico delle schede di memoria (BM25, solo stdlib).

L'indice MEMORY.md resta piccolo e sempre caricato; questo script pesca le
schede rilevanti per il prompt corrente e ne inietta solo nome, descrizione e
path: decide il modello se aprirle (come le regole "model decision" di
Cursor/Windsurf o la Knowledge di Devin).

Uso:
  recall.py "testo"            top-k in chiaro (CLI, utile a qualunque harness)
  recall.py --hook             hook UserPromptSubmit di Claude Code (JSON su stdin)
  recall.py --eval             barra anti-regressione su eval.json (prompt reali), exit 1 se peggiora
  recall.py --stale 90         schede mai richiamate negli ultimi N giorni
"""
import json, math, os, re, sys, time, unicodedata
from collections import Counter

HOME = os.path.expanduser("~")
MEM = os.environ.get("MEMORY_DIR", f"{HOME}/.claude/projects/-Users-zorahrel/memory")
HERE = os.path.dirname(os.path.realpath(__file__))  # realpath: si lancia anche dal symlink ~/bin/memrecall
LOG = os.path.join(HERE, "hits.log")
K = 3
DESC_CHARS = 160
TRI_WEIGHT = 0.5  # peso dei trigrammi (refusi) rispetto alle parole intere
# Soglie BM25 sulle parole del prompt, tarate sulle domande dispari di eval.json e
# confermate sulle pari. Provati e scartati il 07/10 (nessun guadagno su entrambe le metà):
# corpo delle schede troncato, prompt ripulito dai preamboli di OpenClaw, solo la coda del
# prompt, cancello z-score, peso extra su nome e descrizione.
# Sotto MIN_SCORE l'hook tace; una scheda che combacia solo nel corpo, e non nel nome
# o nella descrizione, deve superare BODY_SCORE.
MIN_SCORE = float(os.environ.get("RECALL_MIN_SCORE", "5"))
BODY_SCORE = float(os.environ.get("RECALL_BODY_SCORE", "8"))
DESC_WEIGHT = 3  # nome e descrizione contano più del corpo
RECALL_BAR, NOISE_BAR = 0.66, 230  # vedi evaluate()

STOP = set("""il lo la i gli le un uno una di a da in con su per tra fra e o ma se che chi cui non
mi ti ci vi si ne è sono era essere ho hai ha abbiamo avete hanno del dello della dei degli delle
al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo
sulla sui sugli sulle come anche più piu poi ora già gia tutto tutti tutte questo questa questi
queste quello quella quelli quelle cosa cose fare fai fa fatto vedi sei sta stai solo ok sì si no
the a an of to in on for and or but is are was be it this that with as at by from not do you we
""".split())


def norm(text):
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    # stemming a prefisso di 5, il classico per le lingue romanze (migrazione/migrazioni):
    # sulle domande pari di eval.json recall 0,80 contro 0,73 con 6
    return [w[:5] for w in re.findall(r"[a-z0-9]{2,}", text) if w not in STOP]


def trigrams(w):
    # i trigrammi reggono i refusi ("mooilight" condivide lig/igh/ght con "moonlight")
    w = f"_{w}_"
    return [w[i:i + 3] for i in range(len(w) - 2)]


def bm25(qterms, docs, field, lfield):
    n = len(docs)
    avg = sum(d[lfield] for d in docs) / n or 1
    df = Counter(t for d in docs for t in d[field] if t in qterms)
    k1, b = 1.2, 0.75
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in qterms}
    out = []
    for d in docs:
        s = 0.0
        for t in qterms:
            tf = d[field].get(t)
            if tf:
                s += idf[t] * tf * (k1 + 1) / (tf + k1 * (1 - b + b * d[lfield] / avg))
        out.append(s)
    return out, idf


def parse(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    name = desc = ""
    body = raw
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", raw, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            if line.startswith("name:"):
                name = line[5:].strip()
            elif line.startswith("description:"):
                desc = line[12:].strip().strip('"')
    if not desc:  # schede senza frontmatter: la prima riga utile fa da descrizione
        desc = next((l.strip("# ").strip() for l in body.splitlines() if l.strip()), "")
    return name, desc, body


def project_memory(cwd):
    """Cartella memory del progetto, come la calcola Claude Code: radice git comune
    (vale anche dai worktree), con / e . sostituiti da -."""
    import subprocess
    try:
        common = subprocess.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute",
                                 "--git-common-dir"], capture_output=True, text=True,
                                timeout=1).stdout.strip()
        root = os.path.dirname(common) if common.endswith("/.git") else cwd
    except Exception:
        root = cwd
    d = f"{HOME}/.claude/projects/{re.sub(r'[/.]', '-', root)}/memory"
    return d if os.path.isdir(d) and d != MEM else None


def memory_dirs(cwd=None):
    extra = project_memory(cwd) if cwd else None
    return [MEM] + ([extra] if extra else [])


def indexed_cards(dirs=None):
    """Schede già linkate nei MEMORY.md: sono nel contesto, non serve iniettarle."""
    out = set()
    for d in dirs or [MEM]:
        try:
            out |= {os.path.join(d, f) for f in
                    re.findall(r"\]\(([^)]+\.md)\)", open(f"{d}/MEMORY.md").read())}
        except OSError:
            pass
    return out


def load_corpus(dirs=None):
    docs = []
    paths = [os.path.join(mem, f) for mem in dirs or [MEM] for f in sorted(os.listdir(mem))
             if f.endswith(".md") and f not in ("MEMORY.md", "ARCHIVE.md")]
    for path in paths:
        f = os.path.basename(path)
        name, desc, body = parse(path)
        head = f"{f.replace('_', ' ')[:-3]} {name} {desc}"
        toks = norm(head) * DESC_WEIGHT + norm(body)
        tri = [g for w in toks for g in trigrams(w)]
        docs.append({"file": f, "path": path, "desc": desc, "tf": Counter(toks), "len": len(toks),
                     "head": set(norm(head)),
                     "tri": Counter(tri), "tlen": len(tri)})
    return docs


def search(query, docs, k=K, exclude=()):
    docs = [d for d in docs if d["path"] not in exclude]
    q = set(norm(query))
    if not q or not docs:
        return []
    qt = {g for t in q for g in trigrams(t)}
    w, _ = bm25(q, docs, "tf", "len")
    t, _ = bm25(qt, docs, "tri", "tlen")
    wmax, tmax = max(w) or 1, max(t) or 1
    scored = []
    for d, ws, ts in zip(docs, w, t):
        # le parole generiche pescate solo dal corpo ("quanti giorni") non bastano
        if ws < MIN_SCORE or (not q & d["head"] and ws < BODY_SCORE):
            continue
        scored.append((ws / wmax + TRI_WEIGHT * ts / tmax, d))
    scored.sort(key=lambda x: -x[0])
    return scored[:k]


def hook():
    # stesso interruttore dell'auto-memory di Claude Code: OpenClaw lo accende e usa la sua
    # memoria (~/.openclaw/memory, tool memory_search); qui proporrebbe schede archiviate
    if os.environ.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "").lower() in ("1", "true"):
        return 0
    try:
        data = json.load(sys.stdin)
        prompt, cwd = data.get("prompt", ""), data.get("cwd") or os.getcwd()
    except Exception:
        return 0  # un hook che si rompe non deve mai bloccare il prompt
    # slash command e messaggi dell'harness (notifiche di task, reminder) non sono domande
    if len(prompt) < 12 or prompt.lstrip().startswith(("/", "<task-notification", "<system-reminder")):
        return 0
    dirs = memory_dirs(cwd)
    hits = search(prompt, load_corpus(dirs), exclude=indexed_cards(dirs))
    if not hits:
        return 0
    # le cartelle una volta sola nell'intestazione, le righe restano corte
    tag = {d: ("" if d == MEM else "[progetto] ") for d in dirs}
    lines = [f"- {tag[os.path.dirname(d['path'])]}{d['file']}: {d['desc'][:DESC_CHARS]}" for _, d in hits]
    base = f"{HOME}/.claude/projects/"
    where = ", ".join(("globale " if d == MEM else "progetto ") + d[len(base):] for d in dirs)
    ctx = (f"Memoria forse pertinente (in ~/.claude/projects/: {where}; apri con Read solo se serve):\n"
           + "\n".join(lines))
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": ctx}}))
    try:
        with open(LOG, "a") as f:
            for _, d in hits:
                f.write(f"{int(time.time())}\t{d['path']}\n")
    except OSError:
        pass
    return 0


def evaluate():
    ev = json.load(open(os.path.join(HERE, "eval.json")))
    split = os.environ.get("RECALL_SPLIT")  # "odd" per tarare, "even" per controllare
    if split:
        ev = [e for i, e in enumerate(ev) if i % 2 == (split == "odd")]
    # ogni domanda gira nella sua sessione: globale più la memoria del progetto ("dir"), come l'hook
    cache = {}

    def ctx(e):
        d = e.get("dir")
        extra = f"{HOME}/.claude/projects/{d}/memory" if d else None
        dirs = [MEM] + ([extra] if extra and extra != MEM and os.path.isdir(extra) else [])
        key = tuple(dirs)
        if key not in cache:
            cache[key] = load_corpus(dirs), indexed_cards(dirs)
        return cache[key]

    pos = [e for e in ev if e["cards"]]
    neg = [e for e in ev if not e["cards"]]
    hit, chars, misses = 0, [], []
    for e in pos:
        docs, idx_paths = ctx(e)
        idx = {os.path.basename(x) for x in idx_paths}
        res = search(e["q"], docs, exclude=idx_paths)
        got = {d["file"] for _, d in res}
        ok = bool(got & set(e["cards"])) or bool(idx & set(e["cards"]))
        hit += ok
        chars.append(sum(len(d["desc"][:DESC_CHARS]) + len(d["file"]) + 4 for _, d in res))
        if not ok:
            misses.append((e["q"][:70].replace("\n", " "), e["cards"][0], [d["file"] for _, d in res]))
    # Sui prompt fuori tema conta il rumore, non il silenzio: lo standard (regole
    # "Apply Intelligently" di Cursor, Knowledge di Devin) mostra descrizioni e lascia
    # decidere al modello.
    noise = [sum(len(d["desc"][:DESC_CHARS]) + len(d["file"]) + 4 for _, d in search(e["q"], ctx(e)[0], exclude=ctx(e)[1]))
             for e in neg]
    recall = hit / len(pos)
    avg_chars = sum(chars) / len(chars)
    avg_noise = sum(noise) / len(noise)
    for q, want, got in misses:
        print(f"  miss: {q!r} voleva {want}, ha dato {got}")
    # Barra anti-regressione, non obiettivo: misurato il 07/10 recall 0,69 e rumore 194 sui
    # prompt reali delle sessioni dove l'hook gira (OpenClaw escluso, ha la sua memoria).
    # Margine di 2 prompt: le schede nuove spostano un po' gli idf ogni giorno.
    print(f"recall@{K} {hit}/{len(pos)} = {recall:.2f} (barra {RECALL_BAR}) · rumore fuori tema "
          f"{avg_noise:.0f} char (barra {NOISE_BAR}) · iniezione media {avg_chars:.0f} char (barra 600)")
    return 0 if recall >= RECALL_BAR and avg_noise <= NOISE_BAR and avg_chars <= 600 else 1


def stale(days):
    since = time.time() - days * 86400
    seen = set()
    try:
        for line in open(LOG):
            ts, f = line.rstrip("\n").split("\t")
            if int(ts) >= since:
                seen.add(f)
    except OSError:
        pass
    dirs = memory_dirs(os.getcwd())
    idx = indexed_cards(dirs)
    for d in load_corpus(dirs):
        if d["path"] not in seen and d["path"] not in idx:
            print(d["path"].replace(HOME, "~"))
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--hook"]:
        sys.exit(hook())
    if a[:1] == ["--eval"]:
        sys.exit(evaluate())
    if a[:1] == ["--stale"]:
        sys.exit(stale(int(a[1]) if len(a) > 1 else 90))
    for s, d in search(" ".join(a), load_corpus(memory_dirs(os.getcwd()))):
        print(f"{s:5.1f}  {d['path'].replace(HOME, '~')}  {d['desc'][:100]}")
