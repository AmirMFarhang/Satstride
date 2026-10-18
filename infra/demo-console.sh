#!/usr/bin/env bash
# Console only: attaches to the existing provider without restarting services.
set -euo pipefail
DEMO_CONSOLE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$DEMO_CONSOLE_ROOT/apps/console/start.mjs" "$@"
