#!/bin/bash
cd "$(dirname "$0")"
swift build -c release
mkdir -p ~/bin
cp .build/release/JarvisTray ~/bin/jarvis-tray 2>/dev/null || true
echo "Built: .build/release/JarvisTray"
