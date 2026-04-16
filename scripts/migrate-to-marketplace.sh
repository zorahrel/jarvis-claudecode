#!/usr/bin/env bash
#
# Jarvis — migrate skills from ~/.claude/skills/ to ~/jarvis/skills-marketplace/.
#
# Run this once after pulling the marketplace-architecture update, if your
# install predates it. Safe to re-run; detects already-migrated installs.
#
# What it does (local only — nothing is pushed or synced):
#   - scans ~/.claude/skills/ for user-owned custom skills
#   - leaves third-party symlinks (agent-reach, firecrawl, etc.) untouched
#   - moves real-dir custom skills into ~/jarvis/skills-marketplace/skills/
#   - re-links the repo-shipped jarvis-config skill into the marketplace
#   - registers the marketplace with Claude Code (idempotent)
#   - preserves a timestamped backup of ~/.claude/skills/ first
#
# Usage:
#   bash scripts/migrate-to-marketplace.sh           # run
#   bash scripts/migrate-to-marketplace.sh --dry-run # print plan only
#   bash scripts/migrate-to-marketplace.sh --force   # re-run even if marketplace exists

set -euo pipefail

DRY=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force)   FORCE=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MP="$HOME/jarvis/skills-marketplace"
OLD="$HOME/.claude/skills"
REPO_SKILL_SRC="$REPO_ROOT/skills/jarvis-config"
TEMPLATE="$REPO_ROOT/skills-marketplace.template"

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
run()   {
  if [ "$DRY" = "1" ]; then
    printf "  ${DIM}[dry] %s${RESET}\n" "$*"
  else
    eval "$@"
  fi
}

# --- 0. Pre-flight -----------------------------------------------------------
step "Pre-flight"

command -v claude >/dev/null 2>&1 || {
  err "claude CLI not found. Install it first (https://docs.claude.com/en/docs/claude-code)."
  exit 1
}
ok "claude $(claude --version 2>/dev/null | head -1)"

# Already migrated? Bail unless --force.
if [ -d "$MP/.claude-plugin" ] && [ "$FORCE" = "0" ]; then
  if claude plugin list 2>/dev/null | grep -q "jarvis-custom-skills"; then
    ok "marketplace already registered and plugin installed — nothing to do"
    ok "re-run with --force to redo the migration steps"
    exit 0
  fi
fi

# --- 1. Scaffold marketplace -------------------------------------------------
step "Scaffolding marketplace at $MP"

if [ ! -d "$MP" ]; then
  if [ -d "$TEMPLATE" ]; then
    run mkdir -p "$MP"
    run cp -R "$TEMPLATE/." "$MP/"
    ok "copied template → $MP"
  else
    err "template missing at $TEMPLATE — is the repo up to date?"
    exit 1
  fi
else
  skip "marketplace directory exists"
fi

run mkdir -p "$MP/skills"

# --- 2. Backup --------------------------------------------------------------
step "Backing up ~/.claude/skills/"
if [ -d "$OLD" ]; then
  BACKUP="$HOME/.claude/skills.backup-$(date +%Y%m%d-%H%M%S)"
  if [ "$DRY" = "1" ]; then
    info "[dry] cp -R $OLD $BACKUP"
  else
    cp -R "$OLD" "$BACKUP"
    ok "backup → $BACKUP"
  fi
else
  skip "no ~/.claude/skills/ to back up"
fi

# --- 3. Move custom real-dir skills -----------------------------------------
step "Moving custom skills into marketplace"

MOVED=()
if [ -d "$OLD" ]; then
  for entry in "$OLD"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    # Skip hidden / archives / third-party symlinks
    case "$name" in
      _*|.*) info "skip $name (archive/hidden)"; continue ;;
    esac
    if [ -L "$entry" ]; then
      # Symlinked skill — likely third-party (agent-reach, firecrawl) or points
      # at the repo's jarvis-config. Don't migrate; handle jarvis-config below.
      info "skip symlink $name"
      continue
    fi
    if [ -d "$entry" ]; then
      dst="$MP/skills/$name"
      if [ -e "$dst" ]; then
        warn "$name: $dst already exists — leaving original in place"
        continue
      fi
      run mv "$entry" "$dst"
      ok "moved $name"
      MOVED+=("$name")
    fi
  done
fi

if [ "${#MOVED[@]}" = "0" ]; then
  info "nothing to move (fresh install or already migrated)"
fi

# --- 4. Link repo-shipped jarvis-config into the marketplace -----------------
step "Linking jarvis-config (shipped with repo) into marketplace"

LINK="$MP/skills/jarvis-config"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  warn "$LINK exists and is not a symlink — leaving as-is"
elif [ -L "$LINK" ]; then
  skip "symlink already present"
elif [ -d "$REPO_SKILL_SRC" ]; then
  run ln -s "$REPO_SKILL_SRC" "$LINK"
  ok "linked $REPO_SKILL_SRC → $LINK"
else
  warn "jarvis-config source missing at $REPO_SKILL_SRC"
fi

# --- 5. Update marketplace.json skills list ---------------------------------
step "Updating marketplace manifest skill list"

MANIFEST="$MP/.claude-plugin/marketplace.json"
if [ -f "$MANIFEST" ] && command -v python3 >/dev/null 2>&1; then
  if [ "$DRY" = "1" ]; then
    info "[dry] rewrite skills array in $MANIFEST"
  else
    python3 - "$MANIFEST" "$MP/skills" <<'PY'
import json, os, sys
manifest_path, skills_dir = sys.argv[1], sys.argv[2]
with open(manifest_path) as f: data = json.load(f)
skills = sorted(
    f"./skills/{d}" for d in os.listdir(skills_dir)
    if os.path.isdir(os.path.join(skills_dir, d)) or os.path.islink(os.path.join(skills_dir, d))
)
for plugin in data.get("plugins", []):
    plugin["skills"] = skills
with open(manifest_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"updated {len(skills)} skill entries")
PY
    ok "manifest updated"
  fi
else
  warn "python3 missing — update skills[] in $MANIFEST manually"
fi

# --- 6. Clean up stale symlinks + archives ----------------------------------
step "Cleaning up ~/.claude/skills/"

if [ -L "$OLD/jarvis-config" ]; then
  run rm "$OLD/jarvis-config"
  ok "removed stale jarvis-config symlink"
fi
if [ -d "$OLD/_archive" ]; then
  run rm -rf "$OLD/_archive"
  ok "removed _archive"
fi

# --- 7. Register + install ---------------------------------------------------
step "Registering marketplace with Claude Code"

if claude plugin marketplace list 2>/dev/null | grep -q "^jarvis-skills\b"; then
  skip "marketplace already registered"
else
  run claude plugin marketplace add "$MP"
  ok "marketplace registered"
fi

if claude plugin list 2>/dev/null | grep -q "jarvis-custom-skills"; then
  skip "plugin already installed"
else
  run claude plugin install jarvis-custom-skills@jarvis-skills
  ok "plugin installed"
fi

# --- Done -------------------------------------------------------------------
step "Done"

cat <<EOF

${BOLD}${GREEN}Migration complete.${RESET}

Verify:
  ${BLUE}claude plugin list${RESET}                            # jarvis-custom-skills should appear
  ${BLUE}claude plugin marketplace list${RESET}                # jarvis-skills should appear
  open a Claude Code session, type ${DIM}/${RESET} and look for your custom skills

Restart the Jarvis router to pick up dashboard changes:
  ${BLUE}launchctl kickstart -k gui/\$(id -u)/com.jarvis.router${RESET}   # macOS
  ${BLUE}systemctl --user restart jarvis-router${RESET}                   # Linux

Rollback (if needed):
  ${BLUE}claude plugin uninstall jarvis-custom-skills@jarvis-skills${RESET}
  ${BLUE}claude plugin marketplace remove jarvis-skills${RESET}
  restore from the backup printed above
EOF
