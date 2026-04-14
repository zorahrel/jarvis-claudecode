#!/usr/bin/env python3
"""Mem0 server for Jarvis conversational memory."""
import os, sys, json, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.stdout.reconfigure(line_buffering=True)

# Load .env for OPENAI_API_KEY
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

HOME = os.path.expanduser("~")

print("Clearing stale Qdrant lock...", flush=True)
lock_file = os.path.join(HOME, ".claude/jarvis/mem0-data/.lock")
if os.path.exists(lock_file):
    try:
        os.remove(lock_file)
        print("  Removed stale .lock file", flush=True)
    except Exception as e:
        print(f"  Could not remove .lock: {e}", flush=True)

print("Importing mem0...", flush=True)
from mem0 import Memory

config = {
    "llm": {
        "provider": "openai",
        "config": {
            "model": "gpt-4.1-nano-2025-04-14",
            "temperature": 0,
        }
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": "text-embedding-3-small",
        }
    },
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "collection_name": "jarvis",
            "path": os.path.join(HOME, ".claude/jarvis/mem0-data"),
        }
    },
    "history_db_path": os.path.join(HOME, ".claude/jarvis/mem0-history.db"),
}

print("Initializing Mem0...", flush=True)
m = Memory.from_config(config)
print("Mem0 ready!", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length:
            return json.loads(self.rfile.read(length))
        return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/search":
            q = params.get("q", [""])[0]
            user_id = params.get("user_id", ["business"])[0]
            limit = int(params.get("limit", ["5"])[0])
            if not q:
                self._json({"error": "q required"}, 400)
                return
            try:
                results = m.search(q, user_id=user_id, limit=limit)
                hits = results.get("results", [])
                self._json({"results": hits, "query": q, "user_id": user_id})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/memories":
            user_id = params.get("user_id", ["business"])[0]
            try:
                results = m.get_all(user_id=user_id)
                memories = results.get("results", []) if isinstance(results, dict) else results
                self._json({"memories": memories, "count": len(memories)})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/stats":
            try:
                # Scopes to iterate over. Override via MEM0_STATS_SCOPES env
                # (comma-separated). Defaults to just "business" + "global".
                scopes_env = os.environ.get("MEM0_STATS_SCOPES", "business,global")
                scopes = [s.strip() for s in scopes_env.split(",") if s.strip()]
                by_user = {}
                total = 0
                for uid in scopes:
                    try:
                        result = m.get_all(user_id=uid)
                        mems = result.get("results", []) if isinstance(result, dict) else result
                        count = len(mems)
                        if count > 0:
                            by_user[uid] = count
                            total += count
                    except:
                        pass
                self._json({"total": total, "by_user_id": by_user})
            except Exception as e:
                self._json({"error": str(e)}, 500)

        elif parsed.path == "/health":
            self._json({"status": "ok"})

        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/add":
            try:
                body = self._read_body()
                text = body.get("text", "")
                user_id = body.get("user_id", "business")
                metadata = body.get("metadata", {})
                if not text:
                    self._json({"error": "text required"}, 400)
                    return
                result = m.add(text, user_id=user_id, metadata=metadata)
                self._json({"ok": True, "result": result})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        # /memory/<id>
        if parsed.path.startswith("/memory/"):
            mem_id = parsed.path[len("/memory/"):]
            try:
                m.delete(mem_id)
                self._json({"ok": True, "deleted": mem_id})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = 3343
    # Bind to 127.0.0.1 by default. Set MEM0_BIND=0.0.0.0 to expose on the
    # network (no auth on this server — only do this on a trusted LAN).
    host = os.environ.get("MEM0_BIND", "127.0.0.1")
    server = HTTPServer((host, port), Handler)
    print(f"Mem0 server running on http://{host}:{port}", flush=True)
    server.serve_forever()
