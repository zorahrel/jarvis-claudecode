#!/bin/bash
# Redeploy JarvisNotch from the agent-notch repo (~/agent-notch) into
# /Applications/JarvisNotch.app. The notch sources live OUTSIDE this repo
# now — see https://github.com/zorahrel/agent-notch.
#
# We delegate the actual build to agent-notch's own `scripts/build-app.sh`
# (single source of truth for Info.plist keys, SwiftPM resource bundle
# layout, codesign defaults). The wrapping below only:
#
#   1. Overrides bundle-id so TCC grants keyed to `io.armonia.jarvis.notch`
#      persist across rebuilds.
#   2. Renames binary + CFBundleExecutable from `agent-notch` to
#      `JarvisNotch`, because the tray supervisor pgrep-x's that name and
#      opens `/Applications/JarvisNotch.app`. Changing the contract means
#      patching the tray too.
#   3. Re-signs with `JarvisNotch.entitlements` (mic / speech / apple-events).
#      Upstream `build-app.sh` only does ad-hoc sign WITHOUT entitlements;
#      WebKit + AVAudioEngine crash without those keys.
#
# Usage:   ./redeploy-notch.sh             (debug build)
#          ./redeploy-notch.sh release     (release build)

set -e
TRAY_APP="$(cd "$(dirname "$0")" && pwd)"
AGENT_NOTCH="${AGENT_NOTCH_SRC:-$HOME/agent-notch}"
APP="/Applications/JarvisNotch.app"
ENT="$TRAY_APP/JarvisNotch.entitlements"
CONFIG="${1:-debug}"

if [[ ! -d "$AGENT_NOTCH" ]]; then
  echo "agent-notch repo not found at $AGENT_NOTCH"
  echo "  git clone https://github.com/zorahrel/agent-notch.git $AGENT_NOTCH"
  echo "  or set AGENT_NOTCH_SRC to override the path."
  exit 1
fi

# Build a real .app bundle via upstream script. The script always builds
# `release`; for dev iterations we shortcut: skip upstream script and do
# a debug-binary swap (which is what redeploy-notch.sh historically did).
if [[ "$CONFIG" == "release" ]]; then
  SHA=$(cd "$AGENT_NOTCH" && git rev-parse --short HEAD)
  TMP_BUNDLE="$AGENT_NOTCH/dist/JarvisNotch.app"
  ( cd "$AGENT_NOTCH" && ./scripts/build-app.sh \
      --output "dist/JarvisNotch.app" \
      --bundle-id "io.armonia.jarvis.notch" \
      --version "0.3.0-dev+$SHA" \
  )

  # Rename binary + Info.plist executable key so the tray supervisor's
  # pgrep -x JarvisNotch finds the process.
  mv "$TMP_BUNDLE/Contents/MacOS/agent-notch" "$TMP_BUNDLE/Contents/MacOS/JarvisNotch"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable JarvisNotch"  "$TMP_BUNDLE/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName JarvisNotch"        "$TMP_BUNDLE/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName JarvisNotch" "$TMP_BUNDLE/Contents/Info.plist"

  # Atomic swap into /Applications: rename to .swap so the tray's pgrep
  # fails the respawn until the new bundle is in place + signed.
  SWAP="${APP}.swap"
  rm -rf "$SWAP"
  cp -R "$TMP_BUNDLE" "$SWAP"

  # Upstream codesigns ad-hoc but WITHOUT entitlements. WebKit / mic
  # capture need the JarvisNotch.entitlements file → re-sign deep ad-hoc.
  codesign -f -s - --deep --entitlements "$ENT" "$SWAP"

  pkill -f JarvisNotch 2>/dev/null || true
  rm -rf "$APP"
  mv "$SWAP" "$APP"
else
  # Debug fast path: just swap binary + SwiftPM resource bundle, keep
  # existing /Applications/JarvisNotch.app skeleton (Info.plist + TCC).
  ( cd "$AGENT_NOTCH" && swift build )
  BUILT="$AGENT_NOTCH/.build/debug/agent-notch"
  RES_BUNDLE_SRC="$AGENT_NOTCH/.build/debug/AgentNotch_AgentNotch.bundle"

  pkill -f JarvisNotch 2>/dev/null || true
  sleep 1

  cp "$BUILT" "$APP/Contents/MacOS/JarvisNotch"

  # Refresh the SwiftPM resource bundle (Orb assets live inside it now).
  if [[ -d "$RES_BUNDLE_SRC" ]]; then
    rm -rf "$APP/Contents/Resources/AgentNotch_AgentNotch.bundle"
    cp -R "$RES_BUNDLE_SRC" "$APP/Contents/Resources/AgentNotch_AgentNotch.bundle"
  fi

  # --deep firma anche nested binaries (Frameworks/, XPC helpers che WebKit
  # usa). `--options runtime` richiede hardened runtime + tutti i nested
  # signed con entitlements coerenti. Con firma ad-hoc (`-`) WebKit GPU
  # process crashava con SIGKILL CODESIGNATURE_INVALID. Drop runtime opt —
  # ad-hoc deep basta.
  codesign -f -s - --deep --entitlements "$ENT" "$APP"
fi

open "$APP"
sleep 2
echo "Deployed at $(date +%H:%M:%S), config=$CONFIG, pid=$(pgrep -f JarvisNotch | head -1)"
echo "Entitlements verify:"
codesign -d --entitlements - "$APP" 2>&1 | grep -E 'audio-input|microphone|speech-recognition' | head -5
