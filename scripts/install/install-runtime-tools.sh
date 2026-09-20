#!/bin/bash
# Install Heimdall command wrappers and remove retired toolkits from older bases.
set -euo pipefail

ROOT="${HEIMDALL_ROOT:-/opt/heimdall}"
BIN_DIR="${HEIMDALL_BIN_DIR:-/usr/local/bin}"
TOOLS="${ROOT}/tools"
COMMANDS="${ROOT}/bin"

test -d "$COMMANDS"
node "${ROOT}/scripts/build/resources.mjs"
mkdir -p "$BIN_DIR"

# COPY overlays do not remove files inherited from an existing Heimdall base.
# Retired private C2 (J35 / zdrive / ztime) must not remain on PATH or in the tree.
rm -rf "${ROOT}/c2" "${TOOLS}/c2" "${ROOT}/proxy/c2" "${TOOLS}/csharp" "${ROOT}/modes"
rm -f "${ROOT}/deploy/install/install-c2-kit.sh"
for name in J35 j35 zdrive xdrive zdrive-selfhost ztime ztimes ztimec; do
  rm -f "${BIN_DIR}/${name}" "${TOOLS}/${name}" \
    "${ROOT}/proxy/${name}" "${TOOLS}/proxy/${name}"
done
hash -r 2>/dev/null || true
for name in J35 j35 zdrive xdrive zdrive-selfhost ztime ztimes ztimec; do
  if command -v "$name" >/dev/null 2>&1; then
    echo "retired toolkit still on PATH: ${name}" >&2
    exit 1
  fi
done
if [ -e "${ROOT}/c2" ] || [ -e "${TOOLS}/c2" ]; then
  echo "retired C2 tree still present" >&2
  exit 1
fi

for path in "${COMMANDS}"/heimdall* "${ROOT}"/scripts/runtime/heimdall_hook_*; do
  [ -f "$path" ] || continue
  case "$path" in *.py|*.cmd) continue ;; esac
  chmod 0755 "$path"
  ln -sfn "$path" "${BIN_DIR}/${path##*/}"
done

test -x "${BIN_DIR}/heimdall"
test -x "${BIN_DIR}/heimdall-agent"
test -x "${BIN_DIR}/heimdall-submit"
