#!/usr/bin/env bash
set -euo pipefail

RB_PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$RB_PROJECT_DIR"

RB_PYTHON_BIN="${REFERENCE_BRIDGE_PYTHON:-python3}"
RB_VENV_DIR="$RB_PROJECT_DIR/.venv-flask"

if ! command -v "$RB_PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 was not found. Install Python 3.10 or newer, then run this file again."
  exit 1
fi

if ! "$RB_PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Reference Bridge requires Python 3.10 or newer."
  exit 1
fi

if [ ! -x "$RB_VENV_DIR/bin/python" ]; then
  "$RB_PYTHON_BIN" -m venv "$RB_VENV_DIR"
fi

"$RB_VENV_DIR/bin/python" -m pip install --disable-pip-version-check --quiet -r flask_app/requirements.txt

for RB_OPTION in "$@"; do
  case "$RB_OPTION" in
    --lan) export REFERENCE_BRIDGE_HOST="0.0.0.0" ;;
    --no-browser) export REFERENCE_BRIDGE_OPEN_BROWSER="0" ;;
  esac
done

exec "$RB_VENV_DIR/bin/python" -m flask_app
