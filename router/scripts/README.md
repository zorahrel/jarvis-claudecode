# Scripts: memory and helper services

| File | Port | What it does |
|---|---|---|
| `docs-server.py` | 3342 | Docs-index: semantic search over `~/.claude/jarvis/memory/**/*.md` (sqlite cache + numpy cosine, MiniLM ONNX embeddings in `state/models/`) |
| `moondream-server.py` | 2020 | Local vision (Moondream Station), only when `MOONDREAM_API_KEY` is not set |

`docs-server.py` runs in its own venv, `docs-env/` (numpy, onnxruntime,
tokenizers), created by `setup.sh`. HTTP contract: `/search?q=&limit=&scope=`,
`/stats`, `/documents`, `POST /reindex`, `/health`. The router talks to it
through `src/services/memory.ts`.

## Retired

- `chroma-server.py`: the ChromaDB server that served :3342 until 2026-07-05,
  replaced by `docs-server.py`. See `docs/memory-consolidation.md`.
- `retired/omega-server.py`: OMEGA conversation memory on :3343, retired on
  2026-09-28. Its memories now live as Markdown in `memory/projects/`, so the
  docs-index finds them. Rollback steps: `memory/tools/memory.md`.
