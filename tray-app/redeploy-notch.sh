#!/bin/bash
# Redeploy JarvisNotch da .build/debug + re-sign con entitlements completi.
# Necessario perché `cp` azzera la firma del bundle → audio-input entitlement
# sparisce → WebKit crasha alla prima checkUsageDescriptionStringForType
# (vedi DiagnosticReports/JarvisNotch-*.ips, __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__).

set -e
TRAY_APP="$HOME/.claude/jarvis/tray-app"
APP="/Applications/JarvisNotch.app"

cd "$TRAY_APP"
swift build "$@"

pkill -f JarvisNotch 2>/dev/null || true
sleep 1

cp .build/debug/JarvisNotch "$APP/Contents/MacOS/JarvisNotch"
rm -rf "$APP/Contents/Resources/Orb"
cp -R Sources/JarvisNotch/Orb "$APP/Contents/Resources/Orb"

# --deep firma anche nested binaries (Frameworks/, XPC helpers che WebKit usa).
# `--options runtime` richiede hardened runtime + tutti i nested signed con
# entitlements coerenti. Con firma ad-hoc (`-`) WebKit GPU process crashava
# con SIGKILL CODESIGNATURE_INVALID. Drop runtime opt — ad-hoc deep basta.
codesign -f -s - --deep \
  --entitlements "$TRAY_APP/JarvisNotch.entitlements" \
  "$APP"

open "$APP"
sleep 2
echo "Deployed at $(date +%H:%M:%S), pid=$(pgrep -f JarvisNotch | head -1)"
echo "Entitlements verify:"
codesign -d --entitlements - "$APP" 2>&1 | grep -E 'audio-input|microphone|speech-recognition' | head -5
