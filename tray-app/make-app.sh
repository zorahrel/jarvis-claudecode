#!/usr/bin/env bash
# Build and ad-hoc sign both Jarvis processes.
#
#   ./make-app.sh            → release build + sign, drops into ./build/
#   ./make-app.sh --install  → same but also installs to /Applications
#                              and relaunches the menubar (which respawns
#                              the notch).
#
# Two repos in play:
#   • JarvisTray.app — built from this repo (Sources/JarvisTray) via swift-bundler.
#   • JarvisNotch.app — wrapper around ~/agent-notch:
#       1. agent-notch's own `scripts/build-app.sh` produces a real .app bundle
#          (single source of truth for Info.plist + SwiftPM resource bundle).
#       2. We override --bundle-id to `io.armonia.jarvis.notch` so TCC grants
#          persist across rebuilds, and rename the binary +
#          CFBundleExecutable to `JarvisNotch` so the tray supervisor's
#          pgrep -x JarvisNotch finds the process.
#       3. We re-sign deep ad-hoc with JarvisNotch.entitlements because
#          upstream signs WITHOUT entitlements (WebKit + mic need them).
#
# No Apple Developer ID is needed; we sign with `-` (ad-hoc). TCC prompts
# will show "JarvisTray" / "JarvisNotch" at first launch and persist so
# long as bundle identifiers and code signatures stay stable between
# rebuilds.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

AGENT_NOTCH="${AGENT_NOTCH_SRC:-$HOME/agent-notch}"

BUNDLER="${SWIFT_BUNDLER:-$(command -v swift-bundler || echo "$HOME/.local/bin/swift-bundler")}"
if [[ ! -x "$BUNDLER" ]]; then
  echo "swift-bundler not found. Install with:"
  echo "  git clone https://github.com/stackotter/swift-bundler /tmp/swift-bundler"
  echo "  (cd /tmp/swift-bundler && swift build -c release)"
  echo "  mkdir -p ~/.local/bin && cp /tmp/swift-bundler/.build/release/swift-bundler ~/.local/bin/"
  exit 1
fi

BUILD_OUT="$HERE/build"
mkdir -p "$BUILD_OUT"

# ── JarvisTray (swift-bundler from this repo) ─────────────────────────
build_tray() {
  local NAME="JarvisTray"
  local ENTITLEMENTS="$HERE/${NAME}.entitlements"
  local BUNDLER_OUT="$HERE/.build/bundler/apps/${NAME}/${NAME}.app"

  echo "==> [$NAME] Building release bundle"
  rm -rf "$BUNDLER_OUT" "$BUILD_OUT/${NAME}.app"
  "$BUNDLER" bundle "$NAME" \
    --configuration release \
    --platform macOS \
    --arch arm64

  [[ -d "$BUNDLER_OUT" ]] || { echo "Bundle failed: $BUNDLER_OUT"; exit 1; }

  echo "==> [$NAME] Ad-hoc signing (no hardened runtime)"
  codesign \
    --sign - \
    --force --deep \
    --entitlements "$ENTITLEMENTS" \
    "$BUNDLER_OUT"

  cp -R "$BUNDLER_OUT" "$BUILD_OUT/${NAME}.app"
  local SIZE
  SIZE=$(du -sh "$BUILD_OUT/${NAME}.app" | awk '{print $1}')
  echo "==> [$NAME] Done: build/${NAME}.app ($SIZE)"
}

# ── JarvisNotch (thin wrapper over agent-notch/scripts/build-app.sh) ──
build_notch() {
  local NAME="JarvisNotch"
  local ENTITLEMENTS="$HERE/${NAME}.entitlements"
  local OUT_APP="$BUILD_OUT/${NAME}.app"
  local UPSTREAM_OUT="$AGENT_NOTCH/dist/${NAME}.app"

  if [[ ! -d "$AGENT_NOTCH" ]]; then
    echo "==> [$NAME] agent-notch repo not found at $AGENT_NOTCH"
    echo "    git clone https://github.com/zorahrel/agent-notch.git $AGENT_NOTCH"
    echo "    or set AGENT_NOTCH_SRC to override."
    exit 1
  fi

  local SHA
  SHA=$(cd "$AGENT_NOTCH" && git rev-parse --short HEAD)

  echo "==> [$NAME] Delegating build to $AGENT_NOTCH/scripts/build-app.sh"
  ( cd "$AGENT_NOTCH" && ./scripts/build-app.sh \
      --output "dist/${NAME}.app" \
      --bundle-id "io.armonia.jarvis.notch" \
      --version  "0.3.0-dev+${SHA}" )

  [[ -d "$UPSTREAM_OUT" ]] || { echo "Upstream build did not produce $UPSTREAM_OUT"; exit 1; }

  echo "==> [$NAME] Renaming binary + Info.plist executable for tray contract"
  mv "$UPSTREAM_OUT/Contents/MacOS/agent-notch" "$UPSTREAM_OUT/Contents/MacOS/${NAME}"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable ${NAME}"  "$UPSTREAM_OUT/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName ${NAME}"        "$UPSTREAM_OUT/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${NAME}" "$UPSTREAM_OUT/Contents/Info.plist"

  echo "==> [$NAME] Re-signing ad-hoc with JarvisNotch.entitlements (mic / speech / apple-events)"
  codesign \
    --sign - \
    --force --deep \
    --entitlements "$ENTITLEMENTS" \
    "$UPSTREAM_OUT"

  rm -rf "$OUT_APP"
  cp -R "$UPSTREAM_OUT" "$OUT_APP"
  local SIZE
  SIZE=$(du -sh "$OUT_APP" | awk '{print $1}')
  echo "==> [$NAME] Done: build/${NAME}.app ($SIZE)"
}

build_tray
build_notch

if [[ "${1:-}" == "--install" ]]; then
  echo "==> Installing both to /Applications"
  pkill -9 JarvisTray 2>/dev/null || true
  pkill -9 JarvisNotch 2>/dev/null || true
  # `Jarvis` from the old single-bundle build, if still around.
  pkill -9 Jarvis 2>/dev/null || true
  for NAME in JarvisTray JarvisNotch; do
    rm -rf "/Applications/${NAME}.app"
    cp -R "$BUILD_OUT/${NAME}.app" "/Applications/${NAME}.app"
    /usr/bin/xattr -r -d com.apple.quarantine "/Applications/${NAME}.app" 2>/dev/null || true
  done
  # Launch only the menubar; it will spawn the notch on startup if the
  # user left `jarvis.notch.wanted` enabled (default true on first run).
  open /Applications/JarvisTray.app
  echo "==> Launched /Applications/JarvisTray.app (notch will follow)"
fi
