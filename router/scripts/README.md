# Scripts — Memory services

Two local Python HTTP servers back Jarvis's memory layer. Both run
entirely on-device with no external API keys.

| File | Port | Purpose | Model |
|---|---|---|---|
| `chroma-server.py` | 3342 | Document memory — indexes `memory/**/*.md` | `all-MiniLM-L6-v2` ONNX |
| `omega-server.py`  | 3343 | Conversation memory — SQLite + `sqlite-vec` + FTS5 | `bge-small-en-v1.5` ONNX |

The router reads `MEMORY_URL` from the environment (default
`http://localhost:3343`) and talks to OMEGA for all conversation-memory
operations (`/search`, `/add`, `/memories`, `/stats`, `DELETE /memory/:id`).

## Starting OMEGA

### One-shot (development)

```bash
cd router/scripts
python3 -m venv omega-env              # first time only
source omega-env/bin/activate
pip install 'omega-memory[server]'
omega setup --download-model --client venv
python3 omega-server.py
```

The store lives at `~/.omega/omega.db`.

### Persistent (macOS LaunchAgent)

```bash
# from router/scripts/
sed "s|__HOME__|$HOME|g" com.jarvis.omega.plist.example \
  > ~/Library/LaunchAgents/com.jarvis.omega.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.omega.plist
tail -f ~/.claude/jarvis/logs/omega.log
```

## Storing and retrieving memories

```bash
# Store
curl -X POST http://localhost:3343/add \
  -H 'Content-Type: application/json' \
  -d '{"content":"Jarvis prefers flat, subscription-based backends","user_id":"global"}'

# Semantic search (top 5 by default)
curl "http://localhost:3343/search?q=subscription&user_id=global"

# Stats
curl http://localhost:3343/stats
```

## Notes

- The OMEGA store at `~/.omega/omega.db` and any local memory exports
  must never be committed; the default `.gitignore` already covers the
  common patterns.
- Both servers run with `KeepAlive: true` under launchd in production.
