#!/bin/bash
# Weekly disk hygiene: prunes the throwaway areas that regrow on their own.
# Installed as com.jarvis.disk-hygiene (LaunchAgent, Sundays 03:00).
# Log: ~/Library/Logs/jarvis-disk-hygiene.log

set -u
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

before=$(df -m / | awk 'NR==2{print $4}')
log "start, ${before} MB free"

# 1. jcode scratch: disposable by definition, keep the last 7 days.
python3 "$HOME/.claude/jarvis/router/scripts/prune_scratch.py" 7 2>&1 | sed 's/^/  scratch: /'

# 2. Abandoned Chrome temp profiles in $TMPDIR (dr-*), skipping live ones.
python3 "$HOME/.claude/jarvis/router/scripts/prune_chrome_temp.py" 2>&1 | sed 's/^/  chrome: /'

# 3. Package manager caches (all re-downloadable).
npm cache clean --force >/dev/null 2>&1 && log "  npm cache cleaned"
python3 -m pip cache purge >/dev/null 2>&1 && log "  pip cache purged"
go clean -cache >/dev/null 2>&1 && log "  go build cache cleaned"
# uvx MCP servers (fli-mcp) hold the cache lock for days: don't wait 300s for nothing.
UV_LOCK_TIMEOUT=10 uv cache prune 2>&1 | tail -1 | sed 's/^/  uv: /'
command -v brew >/dev/null && brew cleanup --prune=30 2>&1 | tail -1 | sed 's/^/  brew: /'

# 4. MCP debug logs from Claude Code (pure noise, several GB/month).
find "$HOME/Library/Caches/claude-cli-nodejs" -type d -name "mcp-logs-*" -mtime +14 -exec rm -rf {} + 2>/dev/null
log "  mcp logs older than 14d pruned"

# 5. npx one-shot packages: npm never expires these, they only pile up.
python3 - <<'PY' 2>&1 | sed 's/^/  npx: /'
import os, shutil, time
d = os.path.expanduser("~/.npm/_npx")
cut = time.time() - 30 * 86400
n = freed = 0
for x in os.listdir(d) if os.path.isdir(d) else []:
    p = os.path.join(d, x)
    try:
        if os.lstat(p).st_mtime >= cut:
            continue
    except OSError:
        continue
    for rr, _, fs in os.walk(p, onerror=lambda e: None):
        for f in fs:
            try:
                freed += os.lstat(os.path.join(rr, f)).st_size
            except OSError:
                pass
    shutil.rmtree(p, ignore_errors=True)
    n += 1
print(f"removed {n} entries older than 30d, {freed/1e9:.2f} GB")
PY

# 6. OpenClaw tmp: model-catalog, update-canary, plugin-build dirs are never
#    deleted by OpenClaw itself (24 GB on 03/10/2026). Keep 3 days.
python3 "$HOME/.claude/jarvis/router/scripts/prune_stale.py" "$HOME/.openclaw/tmp" 3 2>&1 | sed 's/^/  openclaw-tmp: /'

# 7. bun + pnpm caches. bun refuses `pm cache rm` outside a project, hence the stub dir.
stub=$(mktemp -d) && echo '{}' > "$stub/package.json" \
  && (cd "$stub" && "$HOME/.bun/bin/bun" pm cache rm 2>&1 | tail -1 | sed 's/^/  bun: /')
rm -rf "$stub" "$HOME/Library/Caches/bun"
# launchd starts in /, where pnpm exits 226 without a word: run it from $HOME.
(cd "$HOME" && pnpm store prune 2>&1 | tail -1 | sed 's/^/  pnpm: /')

# 8. Spotify streaming cache (8.9 GB on 03/10/2026). Only when Spotify is closed.
if ! pgrep -xq Spotify; then
  rm -rf "$HOME/Library/Caches/com.spotify.client/Data" && log "  spotify cache cleared"
fi

# 9. Build output left behind in projects nobody built for 14 days.
find "$HOME/Projects" "$HOME/Sites" -maxdepth 3 -type d \( -name .next -o -name .turbo \) -mtime +14 -prune 2>/dev/null \
  | while read -r d; do rm -rf "$d" && log "  build: $d"; done

# 9b. Claude Code session temp in /private/tmp/claude-501: dead sessions untouched
#     for 24h (7 GB on 03/10/2026). Live sessions are never touched.
python3 "$HOME/.claude/jarvis/router/scripts/prune_claude_tmp.py" 24 2>&1 | sed 's/^/  claude-tmp: /'

after=$(df -m / | awk 'NR==2{print $4}')
log "done, ${after} MB free (freed $((after - before)) MB)"

# 10. Alert: last time the disk went from 210 to 75 GB free in one week
#     unnoticed. Below 60 GB, say so where Attilio sees it.
if [ "$after" -lt 61440 ]; then
  msg="Disco: solo $((after / 1024)) GB liberi. Guarda ~/Library/Logs/jarvis-disk-hygiene.log"
  osascript -e "display notification \"$msg\" with title \"Jarvis disk-hygiene\" sound name \"Basso\"" 2>/dev/null
  log "  ALERT: $msg"
fi
