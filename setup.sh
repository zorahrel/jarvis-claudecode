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

# --- 3b. Moondream Station venv (local vision, MLX/Apple Silicon) -----------
# Separate venv from omega-env because Moondream Station pulls a heavyweight
# transformers + torch + mlx stack and we want crash isolation. Pin
# transformers <5 because moondream-2 hub code references attributes
# (all_tied_weights_keys) that were removed in transformers 5.x.
step "Setting up Moondream Station local-vision server"
MD_VENV="$SCRIPTS/moondream-env"
if [ ! -d "$MD_VENV" ]; then
  if command -v python3.12 >/dev/null 2>&1; then
    python3.12 -m venv "$MD_VENV"
    ok "created venv at router/scripts/moondream-env (python 3.12)"
  else
    warn "python 3.12 not found — Moondream Station requires it; skipping vision setup"
    MD_VENV=""
  fi
else
  skip "moondream-env already exists"
fi

if [ -n "$MD_VENV" ] && [ -x "$MD_VENV/bin/pip" ]; then
  # shellcheck disable=SC1091
  source "$MD_VENV/bin/activate"
  if ! python -c "import moondream_station" 2>/dev/null; then
    info "installing moondream-station + runtime deps (≈2 min)"
    pip install --quiet --upgrade pip
    pip install --quiet \
      moondream-station \
      "transformers>=4.56,<5.0" \
      pydantic packaging fastapi uvicorn requests
    ok "moondream-station installed"
  else
    skip "moondream-station already installed"
  fi
  deactivate

  info "first boot of com.jarvis.moondream will download Moondream 2 (~1-2 GB)"
fi

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

# --- 6. Install the Jarvis skills marketplace -------------------------------
# Skills live in ~/jarvis/skills-marketplace/ (outside ~/.claude/) so Jarvis
# agents running from remote channels can write new skills without hitting
# Claude Code's safetyCheck on ~/.claude/**.
step "Setting up Jarvis skills marketplace"
MP_DIR="$HOME/jarvis/skills-marketplace"
MP_MANIFEST="$MP_DIR/.claude-plugin/marketplace.json"
TEMPLATE="$REPO_ROOT/skills-marketplace.template"

# Detect pre-1.1 install: the only signature this setup.sh ever created was
# the symlink at ~/.claude/skills/jarvis-config → $REPO_ROOT/skills/jarvis-config.
# If it's present, the install predates the marketplace layout and needs the
# migration script before setup can proceed with the new flow.
if [ -L "$HOME/.claude/skills/jarvis-config" ]; then
  warn "pre-marketplace skill layout detected"
  info "run:  bash scripts/migrate-to-marketplace.sh"
  info "(or re-run setup.sh after migration)"
else
  if [ ! -f "$MP_MANIFEST" ] && [ -d "$TEMPLATE" ]; then
    mkdir -p "$MP_DIR"
    cp -R "$TEMPLATE/." "$MP_DIR/"
    ok "scaffolded $MP_DIR"
  fi

  SKILL_SRC="$REPO_ROOT/skills/jarvis-config"
  SKILL_LINK="$MP_DIR/skills/jarvis-config"
  if [ -d "$SKILL_SRC" ] && [ ! -e "$SKILL_LINK" ]; then
    mkdir -p "$MP_DIR/skills"
    ln -s "$SKILL_SRC" "$SKILL_LINK"
    ok "linked jarvis-config into marketplace"
  fi

  if command -v claude >/dev/null 2>&1 && [ -f "$MP_MANIFEST" ]; then
    if ! claude plugin marketplace list 2>/dev/null | grep -q "^jarvis-skills\b"; then
      claude plugin marketplace add "$MP_DIR" >/dev/null 2>&1 \
        && ok "marketplace registered" \
        || warn "marketplace registration failed (run manually: claude plugin marketplace add $MP_DIR)"
    else
      skip "marketplace already registered"
    fi

    if ! claude plugin list 2>/dev/null | grep -q "jarvis-custom-skills"; then
      claude plugin install jarvis-custom-skills@jarvis-skills >/dev/null 2>&1 \
        && ok "plugin installed" \
        || warn "plugin install failed (run manually: claude plugin install jarvis-custom-skills@jarvis-skills)"
    else
      skip "plugin already installed"
    fi
  else
    info "skill marketplace scaffolded at $MP_DIR (install claude CLI to register)"
  fi
fi

# --- 7. System services (auto-start router + memory servers) ---------------
#
# Three services registered per platform so the user never has to keep a
# terminal open:
#   chroma (:3342)  ·  omega (:3343)  ·  router (:3340/:3341)
#
# macOS → LaunchAgents (launchctl)     Linux → systemd user units
# Windows setup is handled by setup.ps1.
#
SERVICES_INSTALLED=0
LOGS_DIR="$HOME/.claude/jarvis/logs"
mkdir -p "$LOGS_DIR"

NODE_BIN="$(command -v node 2>/dev/null || true)"
NODE_DIR="$(dirname "$NODE_BIN" 2>/dev/null || true)"

PLATFORM="$(uname -s)"

render_template() {
  # $1 = source, $2 = destination
  sed -e "s|__HOME__|$HOME|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__NODE_DIR__|$NODE_DIR|g" \
      "$1" > "$2"
}

if [ "$NO_AGENTS" = "1" ]; then
  step "System services"
  skip "auto-start disabled (--no-agents)"
elif [ "$PLATFORM" = "Darwin" ]; then
  step "Installing LaunchAgents (chroma + omega + router)"
  LA_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$LA_DIR"

  for svc in chroma omega moondream router; do
    template="$SCRIPTS/com.jarvis.${svc}.plist.example"
    target="$LA_DIR/com.jarvis.${svc}.plist"
    if [ ! -f "$template" ]; then
      warn "missing template: $template"; continue
    fi
    render_template "$template" "$target"
    launchctl unload "$target" 2>/dev/null || true
    if launchctl load "$target" 2>/dev/null; then
      ok "com.jarvis.${svc} loaded"
    else
      warn "com.jarvis.${svc} failed to load (check: launchctl list | grep jarvis)"
    fi
  done
  SERVICES_INSTALLED=1

elif [ "$PLATFORM" = "Linux" ]; then
  step "Installing systemd user units (chroma + omega + router)"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found — skipping (install services manually)"
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    for svc in chroma omega moondream router; do
      template="$SCRIPTS/systemd/jarvis-${svc}.service"
      target="$UNIT_DIR/jarvis-${svc}.service"
      if [ ! -f "$template" ]; then
        warn "missing template: $template"; continue
      fi
      render_template "$template" "$target"
      ok "wrote $target"
    done
    systemctl --user daemon-reload
    for svc in chroma omega moondream router; do
      if [ -f "$UNIT_DIR/jarvis-${svc}.service" ]; then
        systemctl --user enable --now "jarvis-${svc}.service" 2>&1 \
          | sed 's/^/    /' || true
        ok "jarvis-${svc} enabled + started"
      fi
    done
    info "tip: run 'loginctl enable-linger $USER' to keep services alive after logout"
    SERVICES_INSTALLED=1
  fi

else
  step "System services"
  warn "platform '$PLATFORM' not handled — start services manually"
fi

# --- Done --------------------------------------------------------------------
cat <<EOF

${BOLD}${GREEN}✓ Setup complete.${RESET}

${BOLD}Next:${RESET}
  1. Fill in bot tokens:          ${DIM}router/.env${RESET}
  2. Review routes & channels:    ${DIM}router/config.yaml${RESET}
  3. Customize your first agent:  ${DIM}agents/default/${RESET}
EOF

if [ "$SERVICES_INSTALLED" = "1" ]; then
  if [ "$PLATFORM" = "Darwin" ]; then
    MANAGE_CMD="launchctl list | grep jarvis"
    RESTART_CMD="launchctl kickstart -k gui/\$(id -u)/com.jarvis.router"
  else
    MANAGE_CMD="systemctl --user status 'jarvis-*'"
    RESTART_CMD="systemctl --user restart jarvis-router"
  fi
  cat <<EOF

${BOLD}All services are running and auto-start at login:${RESET}
  ${DIM}ChromaDB  (docs)          :3342${RESET}
  ${DIM}OMEGA     (conversation)  :3343${RESET}
  ${DIM}Moondream (local vision)  :2020${RESET}
  ${DIM}Router    (bots + web UI) :3340 / :3341${RESET}

  Logs:     ${DIM}~/.claude/jarvis/logs/${RESET}
  Manage:   ${BLUE}${MANAGE_CMD}${RESET}
  Restart:  ${BLUE}${RESTART_CMD}${RESET}

Dashboard: ${BLUE}http://localhost:3340${RESET}

${BOLD}${YELLOW}Important:${RESET} the router is live now, but it won't connect to any
channel until you fill in tokens and restart it:
  1. Edit ${DIM}router/.env${RESET} with TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN
  2. Edit ${DIM}router/config.yaml${RESET} with your chat IDs
  3. ${BLUE}${RESTART_CMD}${RESET}
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
