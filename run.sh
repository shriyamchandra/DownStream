#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="electron"
SKIP_INSTALL="false"

usage() {
  cat <<'EOF'
Usage: ./run.sh [mode] [options]

Modes:
  electron   Launch the Electron desktop app (default)
  web        Run the Express backend + web UI (http://localhost:3000 or $PORT)
  tauri      Run the Tauri desktop app

Options:
  --no-install    Skip npm install even if node_modules is missing
  -h, --help      Show this help
EOF
}

kill_port_listeners() {
  local port="$1"
  local pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    local targets=()
    for pid in $pids; do
      local cmd
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
      if [[ "$cmd" == *"node"* || "$cmd" == *"electron"* || "$cmd" == *"aria2c"* || -z "$cmd" ]]; then
        targets+=("$pid")
      else
        echo "Skipping non-target PID $pid ($cmd) on port $port"
      fi
    done
    if [[ ${#targets[@]} -gt 0 ]]; then
      echo "Stopping process(es) on port $port: ${targets[*]}"
      kill "${targets[@]}" 2>/dev/null || true
      # force
      for pid in "${targets[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
      done
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    electron|--electron)
      MODE="electron"
      ;;
    web|--web)
      MODE="web"
      ;;
    tauri|--tauri)
      MODE="tauri"
      ;;
    --no-install|--skip-install)
      SKIP_INSTALL="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install from https://nodejs.org/"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js from https://nodejs.org/"
  exit 1
fi

if [[ "$SKIP_INSTALL" != "true" && ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Installing dependencies..."
  (cd "$ROOT_DIR" && npm install)
fi

if [[ ! -x "$ROOT_DIR/bin/aria2c" ]] && ! command -v aria2c >/dev/null 2>&1; then
  echo "Warning: aria2c not found in PATH and bin/aria2c is missing."
  echo "         Downloads will fail until aria2c is available."
fi

echo "Ensuring project ports are free..."
WEB_P="${PORT:-${WEB_PORT:-3000}}"
ARIA_P="${ARIA2_PORT:-6800}"
kill_port_listeners "$WEB_P"
kill_port_listeners "$ARIA_P"

case "$MODE" in
  electron)
    echo "Starting Electron app..."
    (cd "$ROOT_DIR" && npm start)
    ;;
  web)
    echo "Starting backend + web UI..."
    (cd "$ROOT_DIR" && npm run dev)
    ;;
  tauri)
    echo "Starting Tauri app..."
    (cd "$ROOT_DIR" && npx tauri dev)
    ;;
  *)
    echo "Unsupported mode: $MODE"
    exit 1
    ;;
esac
