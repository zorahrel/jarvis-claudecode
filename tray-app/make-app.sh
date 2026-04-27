#!/usr/bin/env bash
# Build and ad-hoc sign both Jarvis processes.
#
#   ./make-app.sh            → release build + sign, drops into ./build/
#   ./make-app.sh --install  → same but also installs to /Applications
#                              and relaunches the menubar (which respawns
#                              the notch).
#
# No Apple Developer ID is needed; we sign with `-` (ad-hoc). TCC prompts
# will show "JarvisTray" / "JarvisNotch" at first launch and persist so
# long as bundle identifiers and code signatures stay stable between
# rebuilds.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

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

build_app() {
  local NAME="$1"
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

build_app JarvisTray
build_app JarvisNotch

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
