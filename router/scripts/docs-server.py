#!/usr/bin/env python3
"""Docs-index server for Jarvis memory — drop-in replacement for chroma-server.py.

Serves the exact same HTTP contract on :3342 (/search /stats /documents /health
/reindex) over the same corpus (memory/*.md), but with no chromadb dependency:

  - Embeddings: exact replica of ChromaDB's default ONNXMiniLM_L6_V2
    (tokenizers + onnxruntime + masked mean-pooling + L2 norm, max_len 256),
    so vectors — and therefore ranking — match the previous stack.
  - Store: plain sqlite (state/docs-index.db) used as an embedding cache keyed
    by content hash; at runtime vectors live in RAM (~N x 384 float32) and
    search is exact brute-force cosine via numpy. At this corpus size exact
    search is both simpler and more correct than HNSW.
  - Reindex is incremental: only chunks whose content changed are re-embedded.

Rollback: the old chroma-server.py + chroma-data/ are left untouched; restoring
the previous launchd plist brings the old stack back as-is.
"""
import os, sys, glob, json, time, hashlib, sqlite3, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import numpy as np

# Serialize index_all(): prevents cascade POST /reindex calls from racing each
# other (each run rewrites the cache; concurrent runs would interleave writes).
_INDEX_LOCK = threading.Lock()

sys.stdout.reconfigure(line_buffering=True)

HOME = os.path.expanduser("~")
JARVIS = os.path.join(HOME, ".claude/jarvis")
DB_PATH = os.environ.get("DOCS_DB", os.path.join(JARVIS, "state/docs-index.db"))
# Jarvis-owned copy of the model; falls back to the chroma cache if missing.
MODEL_DIR = os.environ.get("DOCS_MODEL_DIR", os.path.join(JARVIS, "state/models/all-MiniLM-L6-v2"))
_FALLBACK_MODEL_DIR = os.path.join(HOME, ".cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx")
if not os.path.exists(os.path.join(MODEL_DIR, "model.onnx")):
    MODEL_DIR = _FALLBACK_MODEL_DIR

DIRS = [
    os.path.join(HOME, ".claude/jarvis/memory/"),
]
# Extra memory directories can be added via CHROMA_EXTRA_DIRS env (colon-separated).
for extra in filter(None, os.environ.get("CHROMA_EXTRA_DIRS", "").split(":")):
    DIRS.append(os.path.expanduser(extra.rstrip("/") + "/"))


# ---------------------------------------------------------------------------
# Embedding — exact replica of chromadb's ONNXMiniLM_L6_V2 default function.
# ---------------------------------------------------------------------------
class MiniLMEmbedder:
    def __init__(self, model_dir):
        import onnxruntime
        from tokenizers import Tokenizer
        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        so = onnxruntime.SessionOptions()
        self.session = onnxruntime.InferenceSession(
            os.path.join(model_dir, "model.onnx"),
            sess_options=so,
            providers=["CPUExecutionProvider"],
        )

    def __call__(self, texts, batch_size=32):
        out = []
        for i in range(0, len(texts), batch_size):
            batch = self.tokenizer.encode_batch(texts[i:i + batch_size])
            input_ids = np.array([e.ids for e in batch], dtype=np.int64)
            attention_mask = np.array([e.attention_mask for e in batch], dtype=np.int64)
            onnx_input = {
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "token_type_ids": np.zeros_like(input_ids),
            }
            last_hidden = self.session.run(None, onnx_input)[0]
            mask = np.broadcast_to(np.expand_dims(attention_mask, -1), last_hidden.shape)
            emb = np.sum(last_hidden * mask, 1) / np.clip(mask.sum(1), 1e-9, None)
            norms = np.linalg.norm(emb, axis=1, keepdims=True)
            norms[norms == 0] = 1e-12
            out.append((emb / norms).astype(np.float32))
        return np.vstack(out) if out else np.zeros((0, 384), dtype=np.float32)


embedder = MiniLMEmbedder(MODEL_DIR)


# ---------------------------------------------------------------------------
# SQLite cache + in-memory snapshot
# ---------------------------------------------------------------------------
def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS chunks(
        id TEXT PRIMARY KEY,
        file TEXT, path TEXT, scope TEXT,
        chunk_i INTEGER, total_chunks INTEGER,
        size INTEGER, first_line TEXT, indexed_at INTEGER,
        content_hash TEXT, text TEXT, embedding BLOB
    )""")
    return conn

# Snapshot served by /search /stats /documents. Replaced atomically as a whole
# tuple: (ids: list[str], metas: list[dict], texts: list[str], matrix: np.ndarray)
_SNAPSHOT = ([], [], [], np.zeros((0, 384), dtype=np.float32))


def _load_snapshot_from_db():
    global _SNAPSHOT
    conn = _db()
    rows = conn.execute(
        "SELECT id, file, path, scope, chunk_i, total_chunks, size, first_line,"
        " indexed_at, text, embedding FROM chunks"
    ).fetchall()
    conn.close()
    ids, metas, texts, vecs = [], [], [], []
    for r in rows:
        ids.append(r[0])
        metas.append({
            "file": r[1], "path": r[2], "scope": r[3], "size": r[6],
            "chunk": r[4], "total_chunks": r[5], "first_line": r[7],
            "indexed_at": r[8],
        })
        texts.append(r[9])
        vecs.append(np.frombuffer(r[10], dtype=np.float32))
    matrix = np.vstack(vecs) if vecs else np.zeros((0, 384), dtype=np.float32)
    _SNAPSHOT = (ids, metas, texts, matrix)
    print(f"Snapshot loaded: {len(ids)} chunks", flush=True)


def get_scope(fp):
    """Derive a scope tag from the file path. Override by setting
    MEMORY_SCOPES_MAP as a JSON object mapping path-substrings to scope names."""
    fp = fp.lower()
    overrides = os.environ.get("MEMORY_SCOPES_MAP")
    if overrides:
        try:
            mapping = json.loads(overrides)
            for needle, scope in mapping.items():
                if needle.lower() in fp:
                    return scope
        except Exception:
            pass
    if "/people/" in fp or "/projects/" in fp: return "business"
    if "/procedures/" in fp or "/tools/" in fp or "/daily/" in fp: return "business"
    return "global"


def collect_files():
    """Collect all .md files across DIRS. De-dup by absolute path; excludes
    /archive/ to match dashboard's walkMemoryDir."""
    files = []
    seen_paths = set()
    for d in DIRS:
        if os.path.isdir(d):
            for f in glob.glob(os.path.join(d, "**/*.md"), recursive=True):
                if "/archive/" in f or "/node_modules/" in f:
                    continue
                ap = os.path.abspath(f)
                if ap in seen_paths:
                    continue
                seen_paths.add(ap)
                files.append(ap)
    return files


def index_all():
    """(Re)index all .md files. Incremental: chunks whose content hash is
    unchanged reuse the cached embedding; only new/changed chunks are embedded.
    Serialized via _INDEX_LOCK — concurrent calls return {"skipped": True}."""
    acquired = _INDEX_LOCK.acquire(blocking=False)
    if not acquired:
        print("Indexing already in progress — skipping concurrent call", flush=True)
        return {"skipped": True, "reason": "already_in_progress"}
    try:
        files = collect_files()
        print(f"Indexing {len(files)} files...", flush=True)
        now = int(time.time())

        # Desired chunk set (same chunking as chroma-server.py)
        desired = []  # (cid, text, meta, content_hash)
        for fp in files:
            try:
                content = open(fp).read().strip()
                if not content or len(content) < 10:
                    continue
                scope = get_scope(fp)
                name = os.path.basename(fp)
                doc_id = hashlib.md5(fp.encode()).hexdigest()
                chunks = [content[i:i + 6000] for i in range(0, len(content), 5500)]
                for ci, chunk in enumerate(chunks):
                    cid = f"{doc_id}_{ci}" if len(chunks) > 1 else doc_id
                    meta = {
                        "file": name, "path": fp, "scope": scope,
                        "size": len(content), "chunk": ci,
                        "total_chunks": len(chunks),
                        "first_line": content.split("\n")[0][:100],
                        "indexed_at": now,
                    }
                    chash = hashlib.sha1(chunk.encode()).hexdigest()
                    desired.append((cid, chunk, meta, chash))
            except Exception as e:
                print(f"  ERR {fp}: {e}", flush=True)

        conn = _db()
        cached = {r[0]: (r[1], r[2]) for r in conn.execute(
            "SELECT id, content_hash, embedding FROM chunks")}

        to_embed = [(i, d) for i, d in enumerate(desired)
                    if d[0] not in cached or cached[d[0]][0] != d[3]]
        embeddings = [None] * len(desired)
        for i, d in enumerate(desired):
            if d[0] in cached and cached[d[0]][0] == d[3]:
                embeddings[i] = np.frombuffer(cached[d[0]][1], dtype=np.float32)
        if to_embed:
            print(f"  Embedding {len(to_embed)}/{len(desired)} changed chunks...", flush=True)
            new_vecs = embedder([d[1] for _, d in to_embed])
            for (i, _), v in zip(to_embed, new_vecs):
                embeddings[i] = v

        # Rewrite cache: upsert all desired rows, drop stale ones
        desired_ids = {d[0] for d in desired}
        conn.executemany(
            "INSERT OR REPLACE INTO chunks(id, file, path, scope, chunk_i,"
            " total_chunks, size, first_line, indexed_at, content_hash, text,"
            " embedding) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(d[0], d[2]["file"], d[2]["path"], d[2]["scope"], d[2]["chunk"],
              d[2]["total_chunks"], d[2]["size"], d[2]["first_line"],
              d[2]["indexed_at"], d[3], d[1],
              np.asarray(embeddings[i], dtype=np.float32).tobytes())
             for i, d in enumerate(desired)])
        stale = [(cid,) for cid in cached if cid not in desired_ids]
        if stale:
            conn.executemany("DELETE FROM chunks WHERE id = ?", stale)
        conn.commit()
        conn.close()

        _load_snapshot_from_db()

        stats = {}
        for d in desired:
            stats[d[2]["scope"]] = stats.get(d[2]["scope"], 0) + 1
        n_files = len(set(d[2]["file"] for d in desired))
        print(f"Indexed {len(desired)} chunks from {n_files} files."
              f" Scopes: {stats} (embedded {len(to_embed)}, reused"
              f" {len(desired) - len(to_embed)})", flush=True)
        return {"chunks": len(desired), "files": n_files, "scopes": stats}
    finally:
        _INDEX_LOCK.release()


def search(q, scope, limit):
    ids, metas, texts, matrix = _SNAPSHOT
    if not ids:
        return []
    qv = embedder([q])[0]
    scores = matrix @ qv
    order = np.argsort(-scores)
    hits = []
    for i in order:
        if scope and metas[i]["scope"] != scope:
            continue
        hits.append({
            "id": ids[i],
            "text": texts[i][:500],
            "score": float(scores[i]),
            "metadata": metas[i],
        })
        if len(hits) >= limit:
            break
    return hits


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/search":
            q = params.get("q", [""])[0]
            scope = params.get("scope", [None])[0]
            limit = int(params.get("limit", ["5"])[0])
            if not q:
                self._json({"error": "q required"}, 400)
                return
            try:
                self._json({"results": search(q, scope, limit), "query": q, "scope": scope})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/stats":
            try:
                _, metas, _, _ = _SNAPSHOT
                scopes = {}
                files = set()
                for m in metas:
                    s = m.get("scope", "unknown")
                    scopes[s] = scopes.get(s, 0) + 1
                    files.add(m.get("file", ""))
                self._json({"total_chunks": len(metas), "total_files": len(files), "by_scope": scopes})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/documents":
            scope = params.get("scope", [None])[0]
            try:
                _, metas, _, _ = _SNAPSHOT
                seen = {}
                for m in metas:
                    if scope and m.get("scope") != scope:
                        continue
                    f = m.get("file", "")
                    if f not in seen:
                        seen[f] = {
                            "file": f,
                            "scope": m.get("scope", ""),
                            "size": m.get("size", 0),
                            "first_line": m.get("first_line", ""),
                            "chunks": m.get("total_chunks", 1),
                            "indexed_at": m.get("indexed_at", 0),
                        }
                self._json({"documents": list(seen.values())})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/health":
            self._json({"status": "ok"})

        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/reindex":
            try:
                result = index_all()
                self._json({"ok": True, **result})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(os.environ.get("DOCS_PORT", "3342"))
    # Bind to 127.0.0.1 by default. CHROMA_BIND kept for compat with the old
    # server's env knob; DOCS_BIND wins if both are set.
    host = os.environ.get("DOCS_BIND", os.environ.get("CHROMA_BIND", "127.0.0.1"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Docs-index server running on http://{host}:{port} (model: {MODEL_DIR})", flush=True)
    # Serve the cached snapshot immediately; refresh in the background.
    try:
        _load_snapshot_from_db()
    except Exception as e:
        print(f"Snapshot load error: {e}", flush=True)
    threading.Thread(target=lambda: index_all(), daemon=True).start()
    server.serve_forever()
