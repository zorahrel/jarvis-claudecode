#!/usr/bin/env bash
#
# Jarvis Claude Code — one-shot setup.
# Idempotent: safe to re-run. Skips steps already done.
#
# Usage:
#   ./setup.sh           # interactive
#   ./setup.sh --quiet   # no prompts, assume defaults

set -euo pipefail

QUIET=0
NO_AGENTS=0
for arg in "$@"; do
  case "$arg" in
    --quiet|-q)    QUIET=1 ;;
    --no-agents)   NO_AGENTS=1 ;;
    --help|-h)
      cat <<USAGE
Usage: $0 [--no-agents] [--quiet]

  --no-agents   Skip LaunchAgent install (macOS only — services must be started manually)
  --quiet       Fewer prompts
USAGE
      exit 0
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER="$REPO_ROOT/router"
SCRIPTS="$ROUTER/scripts"
DASHBOARD="$ROUTER/dashboard"
AGENTS="$REPO_ROOT/agents"
TEMPLATE="$REPO_ROOT/agents.example/default"

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step()  { printf "\n${BOLD}${BLUE}▸ %s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
err()   { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; }
info()  { printf "  ${DIM}%s${RESET}\n" "$1"; }
skip()  { printf "  ${DIM}· %s (skipped)${RESET}\n" "$1"; }

die() { err "$1"; exit 1; }

# --- prerequisite checks -----------------------------------------------------
step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node.js is required. Install from https://nodejs.org (v20+)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node -v))."
ok "Node.js $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is required."
ok "npm $(npm -v)"

command -v python3 >/dev/null 2>&1 || die "Python 3.11+ is required."
PY_OK="$(python3 -c 'import sys; print(1 if sys.version_info >= (3,11) else 0)')"
[ "$PY_OK" = "1" ] || die "Python 3.11+ required (found $(python3 --version))."
ok "Python $(python3 --version | cut -d' ' -f2)"

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code CLI ($(claude --version 2>/dev/null | head -1 || echo installed))"
else
  warn "Claude Code CLI not found — install from https://docs.claude.com/en/docs/claude-code"
  warn "Setup will continue, but the router won't run until it's installed."
fi

for bin in ffmpeg pdftotext; do
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin"
  else
    warn "$bin not found — media pipeline features relying on it will be disabled."
  fi
done

if command -v whisper-cli >/dev/null 2>&1; then
  ok "whisper-cli"
else
  warn "whisper-cli not found — voice-note transcription will be disabled."
fi

# --- 1. Router deps ----------------------------------------------------------
step "Installing router dependencies"
if [ -d "$ROUTER/node_modules" ] && [ -f "$ROUTER/package-lock.json" ] && \
   [ "$ROUTER/node_modules/.package-lock.json" -nt "$ROUTER/package-lock.json" ] 2>/dev/null; then
  skip "router/node_modules up to date"
else
  ( cd "$ROUTER" && npm install --no-fund --no-audit )
  ok "router deps installed"
fi

# --- 2. Dashboard build ------------------------------------------------------
step "Building the dashboard"
if [ ! -d "$DASHBOARD/node_modules" ]; then
  ( cd "$DASHBOARD" && npm install --no-fund --no-audit )
  ok "dashboard deps installed"
else
  skip "dashboard deps"
fi
if [ -d "$DASHBOARD/dist" ] && [ -f "$DASHBOARD/dist/index.html" ]; then
  skip "dashboard already built (delete router/dashboard/dist to rebuild)"
else
  ( cd "$DASHBOARD" && npm run build )
  ok "dashboard built → router/dashboard/dist"
fi

# --- 3. OMEGA venv + model ---------------------------------------------------
step "Setting up OMEGA conversation-memory server"
VENV="$SCRIPTS/omega-env"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
  ok "created venv at router/scripts/omega-env"
else
  skip "omega-env already exists"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

if ! python -c "import omega" 2>/dev/null; then
  info "installing omega-memory[server] (≈30s)"
  pip install --quiet --upgrade pip
  pip install --quiet 'omega-memory[server]'
  ok "omega-memory installed"
else
  skip "omega-memory already installed"
fi

if ! python -c "import chromadb, dotenv" 2>/dev/null; then
  info "installing chromadb + python-dotenv (≈30s)"
  pip install --quiet chromadb python-dotenv
  ok "chromadb installed"
else
  skip "chromadb already installed"
fi

MODEL_CACHE="$HOME/.cache/omega/models/bge-small-en-v1.5-onnx"
if [ ! -d "$MODEL_CACHE" ] || [ -z "$(ls -A "$MODEL_CACHE" 2>/dev/null)" ]; then
  info "downloading ONNX embedding model (≈90 MB, one-time)"
  omega setup --download-model --client venv >/dev/null
  ok "ONNX model ready"
else
  skip "ONNX model already present"
fi

deactivate

# --- 4. Config files ---------------------------------------------------------
step "Creating config files"
if [ -f "$ROUTER/.env" ]; then
  skip "router/.env exists"
else
  cp "$ROUTER/.env.example" "$ROUTER/.env"
  ok "router/.env created (fill in bot tokens)"
fi

if [ -f "$ROUTER/config.yaml" ]; then
  skip "router/config.yaml exists"
else
  cp "$ROUTER/config.example.yaml" "$ROUTER/config.yaml"
  ok "router/config.yaml created (edit to add your routes)"
fi

# --- 5. Default agent --------------------------------------------------------
step "Scaffolding default agent"
if [ -d "$AGENTS/default" ]; then
  skip "agents/default already exists"
else
  mkdir -p "$AGENTS"
  cp -R "$TEMPLATE" "$AGENTS/default"
  ok "agents/default created from template"
  info "edit agents/default/CLAUDE.md and agent.yaml to customize"
fi

# --- 6. LaunchAgents (macOS, auto-start services) ---------------------------
AGENTS_INSTALLED=0
if [ "$(uname)" = "Darwin" ] && [ "$NO_AGENTS" = "0" ]; then
  step "Installing LaunchAgents (memory services will auto-start)"
  LA_DIR="$HOME/Library/LaunchAgents"
  LOGS_DIR="$HOME/.claude/jarvis/logs"
  mkdir -p "$LA_DIR" "$LOGS_DIR"

  for svc in chroma omega; do
    template="$SCRIPTS/com.jarvis.${svc}.plist.example"
    target="$LA_DIR/com.jarvis.${svc}.plist"
    if [ ! -f "$template" ]; then
      warn "missing template: $template"; continue
    fi
    sed "s|__HOME__|$HOME|g" "$template" > "$target"
    # Reload: unload-if-loaded then load, so re-runs pick up template changes.
    launchctl unload "$target" 2>/dev/null || true
    if launchctl load "$target" 2>/dev/null; then
      ok "com.jarvis.${svc} loaded"
    else
      warn "com.jarvis.${svc} failed to load (already running? check: launchctl list | grep jarvis)"
    fi
  done
  AGENTS_INSTALLED=1
elif [ "$(uname)" = "Darwin" ]; then
  skip "LaunchAgents (--no-agents set)"
fi

# --- Done --------------------------------------------------------------------
cat <<EOF

${BOLD}${GREEN}✓ Setup complete.${RESET}

${BOLD}Next:${RESET}
  1. Fill in bot tokens:          ${DIM}router/.env${RESET}
  2. Review routes & channels:    ${DIM}router/config.yaml${RESET}
  3. Customize your first agent:  ${DIM}agents/default/${RESET}
EOF

if [ "$AGENTS_INSTALLED" = "1" ]; then
  cat <<EOF

${BOLD}Memory services are running in the background:${RESET}
  ${DIM}ChromaDB (docs)        :3342${RESET}
  ${DIM}OMEGA    (conversation):3343${RESET}
  Logs: ${DIM}~/.claude/jarvis/logs/{chroma,omega}.log${RESET}
  Manage: ${BLUE}launchctl list | grep jarvis${RESET}

${BOLD}Start the router:${RESET}
  ${BLUE}cd router && npm start${RESET}   ${DIM}# or install the router LaunchAgent — see SETUP.md${RESET}

Dashboard: ${BLUE}http://localhost:3340${RESET}
EOF
else
  cat <<EOF

${BOLD}Start the stack manually:${RESET}
  ${BLUE}cd router${RESET}
  ${BLUE}./scripts/omega-env/bin/python scripts/chroma-server.py &${RESET}   ${DIM}# :3342${RESET}
  ${BLUE}./scripts/omega-env/bin/python scripts/omega-server.py &${RESET}    ${DIM}# :3343${RESET}
  ${BLUE}npm start${RESET}                                                   ${DIM}# :3340${RESET}
EOF
fi
echo
