#!/usr/bin/env python3
"""ChromaDB server for Jarvis memory - indexes .md files with scoping."""
import os, sys, glob, json, time, hashlib, threading
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Serialize index_all(): prevents cascade POST /reindex calls from racing each other
# (each index clears+repopulates, concurrent runs leave the collection in mixed state).
_INDEX_LOCK = threading.Lock()
_INDEX_IN_PROGRESS = False

sys.stdout.reconfigure(line_buffering=True)

# Load .env for OPENAI_API_KEY
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

os.environ["ANONYMIZED_TELEMETRY"] = "false"
import chromadb

HOME = os.path.expanduser("~")
PERSIST_DIR = os.path.join(HOME, ".claude/jarvis/chroma-data")
DIRS = [
    os.path.join(HOME, ".claude/jarvis/memory/"),
]
# Extra memory directories can be added via CHROMA_EXTRA_DIRS env (colon-separated).
for extra in filter(None, os.environ.get("CHROMA_EXTRA_DIRS", "").split(":")):
    DIRS.append(os.path.expanduser(extra.rstrip("/") + "/"))

# Uses ChromaDB's built-in default embedding (all-MiniLM-L6-v2 via onnxruntime).
# Runs locally, zero API keys, zero cost.
client = chromadb.PersistentClient(path=PERSIST_DIR)
collection = client.get_or_create_collection(
    name="jarvis_docs_local",
    metadata={"hnsw:space": "cosine"}
)

def get_scope(fp):
    """Derive a scope tag from the file path. Override by setting MEMORY_SCOPES
    as a JSON object mapping path-substrings to scope names."""
    fp = fp.lower()
    overrides = os.environ.get("MEMORY_SCOPES_MAP")
    if overrides:
        try:
            import json
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
    """Collect all .md files across DIRS.

    De-dup is by absolute path (not basename) so files with identical names
    in different folders (e.g. people/simone-pagano.md + projects/simone-pagano.md)
    are both indexed. Excludes /archive/ to match dashboard's walkMemoryDir.
    """
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
    """Index all .md files into ChromaDB.

    Thread-safe: serialized via _INDEX_LOCK. If a call can't acquire the lock
    immediately another indexing run is in flight — return {"skipped": True}
    rather than racing delete+add against it.
    """
    global _INDEX_IN_PROGRESS
    acquired = _INDEX_LOCK.acquire(blocking=False)
    if not acquired:
        print("Indexing already in progress — skipping concurrent call", flush=True)
        return {"skipped": True, "reason": "already_in_progress"}
    _INDEX_IN_PROGRESS = True
    try:
        files = collect_files()
        print(f"Indexing {len(files)} files...", flush=True)

        # Clear existing
        existing = collection.get()
        if existing["ids"]:
            collection.delete(ids=existing["ids"])

        ids, documents, metadatas = [], [], []
        for fp in files:
            try:
                content = open(fp).read().strip()
                if not content or len(content) < 10:
                    continue
                scope = get_scope(fp)
                name = os.path.basename(fp)
                doc_id = hashlib.md5(fp.encode()).hexdigest()

                # Chunk large files (max ~6000 chars per chunk)
                chunks = [content[i:i+6000] for i in range(0, len(content), 5500)]
                for ci, chunk in enumerate(chunks):
                    cid = f"{doc_id}_{ci}" if len(chunks) > 1 else doc_id
                    ids.append(cid)
                    documents.append(chunk)
                    metadatas.append({
                        "file": name,
                        "path": fp,
                        "scope": scope,
                        "size": len(content),
                        "chunk": ci,
                        "total_chunks": len(chunks),
                        "first_line": content.split("\n")[0][:100],
                        "indexed_at": int(time.time()),
                    })
            except Exception as e:
                print(f"  ERR {fp}: {e}", flush=True)

        if ids:
            # Batch add (ChromaDB handles batching internally up to ~41666)
            BATCH = 100
            for i in range(0, len(ids), BATCH):
                collection.add(
                    ids=ids[i:i+BATCH],
                    documents=documents[i:i+BATCH],
                    metadatas=metadatas[i:i+BATCH],
                )

        stats = {}
        for m in metadatas:
            stats[m["scope"]] = stats.get(m["scope"], 0) + 1
        print(f"Indexed {len(ids)} chunks from {len(set(m['file'] for m in metadatas))} files. Scopes: {stats}", flush=True)
        return {"chunks": len(ids), "files": len(set(m["file"] for m in metadatas)), "scopes": stats}
    finally:
        _INDEX_IN_PROGRESS = False
        _INDEX_LOCK.release()


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
            where = {"scope": scope} if scope else None
            try:
                results = collection.query(
                    query_texts=[q],
                    n_results=limit,
                    where=where,
                )
                hits = []
                for i in range(len(results["ids"][0])):
                    hits.append({
                        "id": results["ids"][0][i],
                        "text": results["documents"][0][i][:500] if results["documents"] else "",
                        "score": 1 - (results["distances"][0][i] if results["distances"] else 0),
                        "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                    })
                self._json({"results": hits, "query": q, "scope": scope})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        
        elif parsed.path == "/stats":
            try:
                all_meta = collection.get(include=["metadatas"])
                scopes = {}
                files = set()
                for m in all_meta["metadatas"]:
                    s = m.get("scope", "unknown")
                    scopes[s] = scopes.get(s, 0) + 1
                    files.add(m.get("file", ""))
                self._json({"total_chunks": len(all_meta["ids"]), "total_files": len(files), "by_scope": scopes})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        
        elif parsed.path == "/documents":
            scope = params.get("scope", [None])[0]
            try:
                where = {"scope": scope} if scope else None
                all_data = collection.get(where=where, include=["metadatas"])
                # Dedupe by file
                seen = {}
                for m in all_data["metadatas"]:
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
    port = 3342
    # Bind to 127.0.0.1 by default. Set CHROMA_BIND=0.0.0.0 to expose on the
    # network (no auth on this server — only do this on a trusted LAN).
    host = os.environ.get("CHROMA_BIND", "127.0.0.1")
    # ThreadingHTTPServer so a long /reindex doesn't block /stats /search
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ChromaDB server running on http://{host}:{port}", flush=True)
    # Index in background thread so the HTTP server starts immediately
    import threading
    def bg_index():
        try:
            index_all()
        except Exception as e:
            print(f"Initial indexing error: {e}", flush=True)
    threading.Thread(target=bg_index, daemon=True).start()
    server.serve_forever()
