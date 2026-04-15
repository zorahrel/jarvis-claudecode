#!/usr/bin/env python3
"""OMEGA HTTP server — conversation memory for Jarvis.

Exposes a small HTTP surface over OMEGA's local SQLite store:
  GET    /health
  GET    /stats
  POST   /add          body: {content|memory, scope|user_id, metadata?, tags?, type?}
  GET    /search       ?q=...&scope|user_id=...&limit=5
  GET    /memories     ?scope|user_id=...
  DELETE /memory/{id}

`scope` / `user_id` is stored both as metadata["scope"] and as tag
`scope:<value>`; search filters by scope when provided.

Default port: 3343  (override with OMEGA_HTTP_PORT)
"""
from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.stdout.reconfigure(line_buffering=True)

try:
    from omega import SQLiteStore, batch_store, delete_memory
except ImportError as e:  # pragma: no cover
    print(f"FATAL: omega-memory not importable ({e}). Activate the venv.", file=sys.stderr)
    sys.exit(1)

PORT = int(os.environ.get("OMEGA_HTTP_PORT", "3343"))

store = SQLiteStore()
print(f"OMEGA store opened: {store.db_path}", flush=True)


def _m_to_dict(m) -> dict:
    """Serialize a MemoryResult to the JSON envelope memory.ts expects."""
    md = getattr(m, "metadata", None) or {}
    tags = getattr(m, "tags", None) or []
    scope = md.get("scope") if isinstance(md, dict) else None
    if not scope:
        for t in tags:
            if isinstance(t, str) and t.startswith("scope:"):
                scope = t.split(":", 1)[1]
                break
    return {
        "id": getattr(m, "id", None) or getattr(m, "node_id", None),
        "memory": getattr(m, "content", None) or getattr(m, "memory", "") or "",
        "metadata": md if isinstance(md, dict) else {},
        "tags": tags,
        "user_id": scope,
        "score": getattr(m, "score", None),
        "created_at": str(getattr(m, "created_at", "")) or None,
    }


def _match_scope(record: dict, scope: str | None) -> bool:
    if not scope:
        return True
    if record.get("user_id") == scope:
        return True
    md = record.get("metadata") or {}
    if isinstance(md, dict) and md.get("scope") == scope:
        return True
    if f"scope:{scope}" in (record.get("tags") or []):
        return True
    return False


def _respond(h: BaseHTTPRequestHandler, status: int, payload: object) -> None:
    body = json.dumps(payload, default=str).encode()
    h.send_response(status)
    h.send_header("Content-Type", "application/json")
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def _all_memories() -> list[dict]:
    return [_m_to_dict(m) for m in store.get_recent(limit=10_000)]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/health":
                return _respond(self, 200, {"status": "ok", "backend": "omega", "db": str(store.db_path)})
            if u.path == "/stats":
                mems = _all_memories()
                by: dict[str, int] = {}
                for r in mems:
                    uid = r.get("user_id") or "_unscoped"
                    by[uid] = by.get(uid, 0) + 1
                return _respond(self, 200, {"total": len(mems), "by_user_id": by})
            if u.path == "/search":
                q = qs.get("q", "")
                scope = qs.get("scope") or qs.get("user_id")
                limit = int(qs.get("limit", "5"))
                if not q:
                    return _respond(self, 200, {"results": []})
                t0 = time.time()
                raw = store.query(q, limit=max(limit * 3, 15))
                results: list[dict] = []
                for m in raw:
                    rec = _m_to_dict(m)
                    if not _match_scope(rec, scope):
                        continue
                    results.append(rec)
                    if len(results) >= limit:
                        break
                return _respond(
                    self,
                    200,
                    {"results": results, "latency_ms": int((time.time() - t0) * 1000)},
                )
            if u.path == "/memories":
                scope = qs.get("scope") or qs.get("user_id")
                mems = _all_memories()
                if scope:
                    mems = [m for m in mems if _match_scope(m, scope)]
                return _respond(self, 200, {"memories": mems, "count": len(mems)})
            return _respond(self, 404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return _respond(self, 500, {"error": str(e)})

    def do_POST(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if u.path == "/add":
                content = body.get("content") or body.get("memory")
                if not content:
                    return _respond(self, 400, {"error": "content required"})
                scope = body.get("scope") or body.get("user_id")
                tags = list(body.get("tags") or [])
                if scope and f"scope:{scope}" not in tags:
                    tags.append(f"scope:{scope}")
                metadata = dict(body.get("metadata") or {})
                if scope and "scope" not in metadata:
                    metadata["scope"] = scope
                result = batch_store(
                    [
                        {
                            "content": content,
                            "type": body.get("type", "memory"),
                            "tags": tags,
                            "metadata": metadata,
                        }
                    ]
                )
                return _respond(self, 200, {"ok": True, "result": result})
            return _respond(self, 404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return _respond(self, 500, {"error": str(e)})

    def do_DELETE(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        try:
            if u.path.startswith("/memory/"):
                mid = u.path.rsplit("/", 1)[-1]
                delete_memory(mid)
                return _respond(self, 200, {"ok": True, "id": mid})
            return _respond(self, 404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return _respond(self, 500, {"error": str(e)})


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"OMEGA HTTP server listening on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
