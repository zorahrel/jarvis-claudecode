#!/usr/bin/env bash
# Runs Context Inspector unit + integration tests (Phase 1).
# Uses Node's built-in test runner (node:test) — NO new npm dependencies.
# Pattern: tsx --test "src/services/contextInspector/**/*.spec.ts"
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Running context-inspector tests..."

FILES=$(find src/services/contextInspector src/dashboard -type f -name "*.spec.ts" 2>/dev/null || true)
if [ -z "$FILES" ]; then
  echo "  (no test files yet — Wave 0)"
  exit 0
fi

echo "  Files: $FILES"
exec npx tsx --test $FILES
