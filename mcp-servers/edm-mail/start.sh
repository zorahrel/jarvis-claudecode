#!/usr/bin/env bash
# Loads non-secret .env, fetches the password from the macOS Keychain, then
# launches the edm-mail MCP stdio server. The password is never on disk.
set -a
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/.env" ] && . "$DIR/.env"
EDM_PASS="$(/usr/bin/security find-generic-password -a "$EDM_USER" -s "${EDM_KEYCHAIN_SERVICE:-edm-mail}" -w 2>/dev/null)"
set +a
if [ -z "$EDM_PASS" ]; then
  echo "[edm-mail] no password in Keychain for $EDM_USER (service ${EDM_KEYCHAIN_SERVICE:-edm-mail})" >&2
  exit 1
fi
exec node "$DIR/index.mjs"
