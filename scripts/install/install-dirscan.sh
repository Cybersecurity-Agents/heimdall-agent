#!/bin/bash
# Directory scan: dirsearch only. Drop ffuf / gobuster / feroxbuster.
# Called from deploy/{unified,executor}.
set -euo pipefail

DIRSEARCH_VER="${DIRSEARCH_VER:-0.5.0}"
VENDOR="${HEIMDALL_DIRSCAN_VENDOR:-/opt/heimdall/vendor/dirscan}"
BINDIR="${VENDOR}/bin"
WRAP_SRC="${HEIMDALL_DIRSCAN_WRAP:-/opt/heimdall/scripts/runtime/dirscan-wrap.sh}"
STAMP="${VENDOR}/VERSION"

# Install tools directly; do not propagate a host proxy.
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY=
export http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*" no_proxy="*"

command -v curl >/dev/null
command -v tar >/dev/null
command -v gzip >/dev/null
command -v pip3 >/dev/null

_drop_other_scanners() {
  rm -f /usr/local/bin/ffuf /usr/local/bin/gobuster /usr/local/bin/feroxbuster
  rm -f "${BINDIR}/ffuf" "${BINDIR}/gobuster" "${BINDIR}/feroxbuster"
  rm -rf /etc/feroxbuster
  if command -v dpkg >/dev/null; then
    dpkg --purge ffuf gobuster >/dev/null 2>&1 || true
  fi
  rm -f /usr/bin/ffuf /usr/bin/gobuster
}

want="${DIRSEARCH_VER} only"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$want" ] \
  && [ -x "${BINDIR}/dirsearch" ] \
  && [ -x /usr/local/bin/dirsearch ]; then
  echo "dirsearch already $want, refresh wrap only"
else
  mkdir -p "$BINDIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  fetch() {
    curl -fsSL --connect-timeout 20 --max-time 180 --retry 4 --retry-delay 2 \
      -A "heimdall-inimage" -o "$2" "$1"
  }

  # Isolated --target: system pip pins fight pwndbg/androguard.
  # PyInstaller releases need GLIBC 2.38 / CPython 3.14, which this image does not have.
  fetch "https://github.com/maurosoria/dirsearch/archive/refs/tags/v${DIRSEARCH_VER}.tar.gz" "$tmp/dirsearch.src.tgz"
  pytarget="${VENDOR}/py"
  rm -rf "$pytarget"
  mkdir -p "$pytarget"
  pip3 install --no-cache-dir --target "$pytarget" --ignore-installed "$tmp/dirsearch.src.tgz"
  cat > "${BINDIR}/dirsearch" <<EOF
#!/usr/bin/env python3
import sys
sys.path.insert(0, "${pytarget}")
from dirsearch.dirsearch import main
raise SystemExit(main())
EOF
  chmod 0755 "${BINDIR}/dirsearch"

  printf '%s\n' "$want" > "$STAMP"
  trap - EXIT
  rm -rf "$tmp"
fi

# Packed image ships only paths.txt. Drop dirsearch's bundled dicc (~10k).
find "$VENDOR" -type f -iname 'dicc.txt' -delete
while IFS= read -r db; do
  find "$db" -type f \( -name '*.txt' -o -name '*.lst' -o -name '*.dic' \) -delete
done < <(find "$VENDOR" -type d -name db)

_drop_other_scanners

test -f "$WRAP_SRC"
install -m 0755 "$WRAP_SRC" "${VENDOR}/dirscan-wrap.sh"
mkdir -p /usr/local/bin
test -x "${BINDIR}/dirsearch"
ln -sfn "${VENDOR}/dirscan-wrap.sh" /usr/local/bin/dirsearch

export PATH="/usr/local/bin:${PATH:-/usr/bin}"
dirsearch --version >/dev/null 2>&1 || dirsearch -h >/dev/null 2>&1 || dirsearch --help >/dev/null
command -v dirsearch
if command -v ffuf >/dev/null 2>&1; then
  echo "leftover ffuf on PATH: $(command -v ffuf)" >&2
  exit 1
fi
if command -v gobuster >/dev/null 2>&1; then
  echo "leftover gobuster on PATH: $(command -v gobuster)" >&2
  exit 1
fi
if command -v feroxbuster >/dev/null 2>&1; then
  echo "leftover feroxbuster on PATH: $(command -v feroxbuster)" >&2
  exit 1
fi
python3 - <<'PY'
import pathlib, shutil
p = pathlib.Path(shutil.which("httpx") or "")
assert p.is_file(), p
assert b"python" not in p.read_bytes()[:80].lower(), p
print("httpx ok", p)
PY
echo "dirscan installed dirsearch=${DIRSEARCH_VER} (ffuf/gobuster/feroxbuster removed)"
