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
uv cache prune 2>&1 | tail -1 | sed 's/^/  uv: /'
command -v brew >/dev/null && brew cleanup --prune=30 2>&1 | tail -1 | sed 's/^/  brew: /'

# 4. MCP debug logs from Claude Code (pure noise, several GB/month).
find "$HOME/Library/Caches/claude-cli-nodejs" -type d -name "mcp-logs-*" -mtime +14 -exec rm -rf {} + 2>/dev/null
log "  mcp logs older than 14d pruned"

after=$(df -m / | awk 'NR==2{print $4}')
log "done, ${after} MB free (freed $((after - before)) MB)"
