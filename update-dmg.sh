#!/usr/bin/env bash
#
# update-dmg.sh — Rebuild the packaged macOS app (.dmg) from current source.
#
# Runs electron-builder to produce a fresh dist/*.dmg that bundles the current
# source (backend/ + frontend/ after the restructure) and the self-contained bin/aria2c.
#
# Usage:
#   ./update-dmg.sh                 Build a fresh dist/*.dmg
#   ./update-dmg.sh --install       Build, then install the app into /Applications
#   ./update-dmg.sh --install --run  Build, install, and launch the app
#   ./update-dmg.sh -h | --help     Show this help
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="DownStream.app"
DO_INSTALL="false"
DO_RUN="false"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL="true" ;;
    --run)     DO_RUN="true" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (use --help)" ;;
  esac
  shift
done

# --- Locate Node/npm -------------------------------------------------------
# Prefer Node on PATH; otherwise fall back to a bundled copy under .node-local.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  LOCAL_NODE_BIN="$(ls -d "$ROOT_DIR"/.node-local/node-*/bin 2>/dev/null | sort | tail -1 || true)"
  if [[ -n "$LOCAL_NODE_BIN" && -x "$LOCAL_NODE_BIN/node" ]]; then
    export PATH="$LOCAL_NODE_BIN:$PATH"
    log "Using bundled Node at $LOCAL_NODE_BIN"
  fi
fi
command -v node >/dev/null 2>&1 || die "Node.js not found. Install it or add it to PATH."
command -v npm  >/dev/null 2>&1 || die "npm not found. Install Node.js."
ok "node $(node --version) / npm $(npm --version)"

cd "$ROOT_DIR"

# --- Sanity-check the bundled aria2c --------------------------------------
if [[ ! -x "$ROOT_DIR/bin/aria2c" ]]; then
  die "bin/aria2c is missing. The packaged backend needs it. \
Build a self-contained aria2c and place it at bin/aria2c first."
fi
if otool -L "$ROOT_DIR/bin/aria2c" 2>/dev/null | grep -q "/opt/homebrew"; then
  warn "bin/aria2c links Homebrew libraries (/opt/homebrew/...)."
  warn "It will FAIL on machines without those libs. Replace it with a self-contained build."
else
  ok "bin/aria2c is self-contained (system libraries only)"
fi

# --- Install deps if needed -----------------------------------------------
if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  log "Installing npm dependencies..."
  npm install
fi

# --- Build -----------------------------------------------------------------
log "Cleaning previous build output..."
rm -f "$ROOT_DIR"/dist/*.dmg "$ROOT_DIR"/dist/*.blockmap 2>/dev/null || true
rm -rf "$ROOT_DIR"/dist/mac-arm64 "$ROOT_DIR"/dist/mac 2>/dev/null || true

log "Building .dmg with electron-builder (this can take a few minutes)..."
npm run pack

DMG="$(ls -t "$ROOT_DIR"/dist/*.dmg 2>/dev/null | head -1 || true)"
[[ -n "$DMG" ]] || die "Build finished but no .dmg was produced in dist/."
ok "Built: $DMG"

# --- Verify the packaged aria2c -------------------------------------------
BUILT_APP="$(ls -d "$ROOT_DIR"/dist/mac-arm64/*.app "$ROOT_DIR"/dist/mac/*.app 2>/dev/null | head -1 || true)"
if [[ -n "$BUILT_APP" && -f "$BUILT_APP/Contents/Resources/aria2c" ]]; then
  if otool -L "$BUILT_APP/Contents/Resources/aria2c" | grep -q "/opt/homebrew"; then
    warn "Packaged aria2c still references Homebrew libs — backend will fail on clean machines."
  else
    ok "Packaged aria2c is self-contained"
  fi
fi

# --- Optional install ------------------------------------------------------
if [[ "$DO_INSTALL" == "true" ]]; then
  [[ -n "$BUILT_APP" ]] || die "Could not locate built .app to install."
  log "Installing to /Applications..."
  # Stop any running instance so we can replace it cleanly.
  pkill -f "$APP_NAME/Contents/MacOS" 2>/dev/null || true
  rm -rf "/Applications/$APP_NAME"
  cp -R "$BUILT_APP" "/Applications/"
  # Strip quarantine so the ad-hoc-signed app opens without a Gatekeeper block.
  xattr -dr com.apple.quarantine "/Applications/$APP_NAME" 2>/dev/null || true
  ok "Installed /Applications/$APP_NAME"

  if [[ "$DO_RUN" == "true" ]]; then
    log "Launching app..."
    open -a "/Applications/$APP_NAME"
  fi
else
  echo
  log "Next steps:"
  echo "  • Install: open \"$DMG\" and drag the app to Applications"
  echo "  • Or re-run with --install to copy it into /Applications automatically"
fi

echo
ok "Done."
