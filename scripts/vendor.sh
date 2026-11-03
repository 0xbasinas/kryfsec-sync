#!/usr/bin/env bash
# Copy the shared sync code into the apps. Usage: bash scripts/vendor.sh [desktop-dir] [mobile-dir]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
desktop="${1:-$here/../cj-split/desktop}"
mobile="${2:-$here/../cj-split/mobile}"
rev="$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo dev)"
for app in "$desktop" "$mobile"; do
  [ -d "$app/src" ] || { echo "skip: $app/src not found"; continue; }
  out="$app/src/sync-core"
  rm -rf "$out" && mkdir -p "$out"
  for f in "$here"/packages/core/src/*.ts; do
    {
      echo "// Copied from https://github.com/0xbasinas/kryfsec-sync (packages/core, $rev). MIT."
      echo "// Do not edit here: change it in kryfsec-sync and run scripts/vendor.sh."
      cat "$f"
    } > "$out/$(basename "$f")"
  done
  echo "vendored -> $out"
done
