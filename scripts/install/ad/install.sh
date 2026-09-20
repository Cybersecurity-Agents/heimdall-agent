#!/usr/bin/env bash
# Install nxc + Impacket + Certipy into an isolated venv.
# Default: /opt/heimdall/ad  then whitelist-link CLIs to /usr/local/bin.
# Never link `httpx` (would shadow ProjectDiscovery httpx).
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PREFIX="${AD_PREFIX:-/opt/heimdall/ad}"
LINK_DIR="${AD_LINK_DIR:-/usr/local/bin}"
PY="${PYTHON:-python3}"
DO_LINK=1
AD_RESOURCES="${HEIMDALL_AD_RESOURCES:-${HERE}/../../../resources/toolkits/ad}"
REQ="${AD_RESOURCES}/requirements.txt"
FALLBACK="${AD_RESOURCES}/requirements-pypi.txt"

usage() {
  cat <<'EOF'
Usage: install.sh [--prefix DIR] [--link-dir DIR] [--no-link] [--python PY]
  --prefix    venv root (default /opt/heimdall/ad or $AD_PREFIX)
  --link-dir  where to symlink CLIs (default /usr/local/bin or $AD_LINK_DIR)
  --no-link   skip symlinks
  --python    python interpreter (default python3)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --link-dir) LINK_DIR="$2"; shift 2 ;;
    --no-link) DO_LINK=0; shift ;;
    --python) PY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Impacket / nxc / certipy only. Never httpx, flask, normalizer, …
LINKS='
nxc
netexec
NetExec
nxcdb
certipy
GetNPUsers.py
GetUserSPNs.py
GetADUsers.py
secretsdump.py
lookupsid.py
wmiexec.py
smbexec.py
atexec.py
psexec.py
dcomexec.py
ntlmrelayx.py
getTGT.py
getST.py
ticketer.py
addcomputer.py
smbclient.py
rpcdump.py
'

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

need_cmd "$PY"
need_cmd git

if ! "$PY" -c 'import venv' 2>/dev/null; then
  echo "python venv module missing (apt: python3-venv)" >&2
  exit 1
fi

echo "AD min kit → ${PREFIX}"
mkdir -p "$PREFIX"
"$PY" -m venv "$PREFIX"
# shellcheck disable=SC1091
. "${PREFIX}/bin/activate"
# certipy-ad 4.8.2 still imports pkg_resources (gone in setuptools 82+).
pip install --upgrade pip 'setuptools>=65,<81' wheel

if [ "${AD_PYPI_ONLY:-}" = 1 ]; then
  echo "WARN: AD_PYPI_ONLY=1; Impacket + certipy-ad (no nxc)" >&2
  pip install --no-cache-dir -r "$FALLBACK"
else
  set +e
  pip install --no-cache-dir -r "$REQ"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if [ "${HEIMDALL_STRICT_TOOLS:-0}" = 1 ]; then exit "$rc"; fi
    echo "WARN: NetExec git install failed; falling back to PyPI Impacket + certipy-ad" >&2
    echo "      (no nxc). Need git+build tools; aardwolf may need rustc." >&2
    pip install --no-cache-dir -r "$FALLBACK"
  fi
fi

if [ -f "${HERE}/README.md" ]; then
  cp -f "${HERE}/README.md" "${PREFIX}/README.md"
fi

link_one() {
  local name="$1"
  local src="${PREFIX}/bin/${name}"
  local dest="${LINK_DIR}/${name}"
  if [ ! -e "$src" ]; then
    return 0
  fi
  case "$name" in
    httpx|flask|normalizer|pw-inspector)
      echo "skip link (would shadow image CLI): $name" >&2
      return 0
      ;;
  esac
  mkdir -p "$LINK_DIR"
  ln -sfn "$src" "$dest"
  echo "link $dest -> $src"
}

if [ "$DO_LINK" -eq 1 ]; then
  if [ -w "$(dirname "$LINK_DIR")" ] || [ -w "$LINK_DIR" ] 2>/dev/null; then
    # shellcheck disable=SC2086
    for name in $LINKS; do
      [ -n "$name" ] || continue
      link_one "$name"
    done
  else
    echo "WARN: $LINK_DIR not writable; export PATH=${PREFIX}/bin:\$PATH" >&2
  fi
fi

ok=0
if [ -x "${PREFIX}/bin/nxc" ]; then
  "${PREFIX}/bin/nxc" --help >/dev/null
  echo "OK nxc"
  ok=1
fi
if [ -x "${PREFIX}/bin/certipy" ]; then
  "${PREFIX}/bin/certipy" --help >/dev/null
  echo "OK certipy"
  ok=1
fi
if [ -x "${PREFIX}/bin/secretsdump.py" ]; then
  "${PREFIX}/bin/secretsdump.py" --help >/dev/null
  echo "OK secretsdump.py"
  ok=1
elif "${PREFIX}/bin/python" -c 'import impacket' 2>/dev/null; then
  echo "OK impacket (module)"
  ok=1
fi

if [ "$ok" -eq 0 ]; then
  echo "ERROR: no nxc / certipy / impacket after install" >&2
  exit 1
fi

echo "done. PATH binaries in ${LINK_DIR} (venv ${PREFIX})"
echo "doc: ${PREFIX}/README.md"
