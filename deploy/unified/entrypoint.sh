#!/usr/bin/env bash
set -euo pipefail
export HEIMDALL_REPO_ROOT="${HEIMDALL_REPO_ROOT:-/opt/heimdall}"
export HEIMDALL_DATA_DIR="${HEIMDALL_DATA_DIR:-$HEIMDALL_REPO_ROOT/data}"
cd "$HEIMDALL_REPO_ROOT"
node deploy/unified/init.mjs
CFG="${HEIMDALL_CONFIG:-$HEIMDALL_DATA_DIR/config/config.yaml}"
exec bin/heimdall --config "$CFG" console --listen "${HEIMDALL_LISTEN:-0.0.0.0:8700}"
