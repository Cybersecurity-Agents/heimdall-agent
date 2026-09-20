#!/bin/bash
# Official jpillora/chisel (https://github.com/jpillora/chisel).
# Host CLI → /usr/local/bin/chisel (file; /opt/heimdall/proxy/chisel may already be a drop dir)
# Cross-platform drop copies → /opt/heimdall/proxy/chisel-drop/
set -euo pipefail

CHISEL_VER="${CHISEL_VER:-1.12.0}"
ROOT="${HEIMDALL_ROOT:-/opt/heimdall}"
PROXY="${ROOT}/proxy"
DROP="${PROXY}/chisel-drop"
CACHE="${CHISEL_CACHE:-${ROOT}/deploy/install/chisel-cache}"
BASE="https://github.com/jpillora/chisel/releases/download/v${CHISEL_VER}"

# Install tools directly; do not propagate a host proxy.
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY=
export http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*" no_proxy="*"

command -v curl >/dev/null
command -v gzip >/dev/null
command -v unzip >/dev/null
command -v sha256sum >/dev/null

mkdir -p "$PROXY" "$DROP"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  local url="$1" dest="$2" name
  name="$(basename "$dest")"
  if [ -f "${CACHE}/${name}" ]; then
    cp -f "${CACHE}/${name}" "$dest"
    return 0
  fi
  curl -fsSL --retry 4 --retry-delay 2 -A "heimdall-chisel" -o "$dest" "$url"
}

# Official checksums from chisel_1.12.0_checksums.txt
want_sha() {
  case "$1" in
    linux_amd64) printf '%s' "f3f180f1d93aa72cce4e6386f98cc06569a0146fbd65eb4423cf83e6434bcfe6" ;;
    linux_386) printf '%s' "d8dd3c93809a0334297db6cefd028aaad8d5d2e757f7c6c3e9c4d6fa054e5317" ;;
    linux_arm64) printf '%s' "2ec6152cd2c74fe0146d4d79e4e7aa174521368c56e433d55e023a92ea404ec3" ;;
    windows_amd64) printf '%s' "600a8ad6f03bc7f6d285fd01ab6a3f8a657204adaafa5666ade9451d18df1ebc" ;;
    *) echo "unknown chisel asset $1" >&2; return 1 ;;
  esac
}

unpack_gz() {
  local src="$1" dest="$2"
  gzip -dc "$src" >"$dest"
  chmod 0755 "$dest"
}

install_linux() {
  local tag="$1" archive dest got
  archive="$tmp/chisel_${CHISEL_VER}_${tag}.gz"
  dest="${DROP}/chisel_${tag}"
  if [ -x "$dest" ]; then
    return 0
  fi
  fetch "${BASE}/chisel_${CHISEL_VER}_${tag}.gz" "$archive"
  got="$(sha256sum "$archive" | awk '{print $1}')"
  if [ "$got" != "$(want_sha "$tag")" ]; then
    echo "chisel ${tag} sha256 mismatch: ${got}" >&2
    exit 1
  fi
  unpack_gz "$archive" "$dest"
}

install_windows() {
  local archive dest got
  archive="$tmp/chisel_${CHISEL_VER}_windows_amd64.zip"
  dest="${DROP}/chisel_windows_amd64.exe"
  if [ -f "$dest" ]; then
    return 0
  fi
  fetch "${BASE}/chisel_${CHISEL_VER}_windows_amd64.zip" "$archive"
  got="$(sha256sum "$archive" | awk '{print $1}')"
  if [ "$got" != "$(want_sha windows_amd64)" ]; then
    echo "chisel windows_amd64 sha256 mismatch: ${got}" >&2
    exit 1
  fi
  unzip -qo "$archive" -d "$tmp/win"
  if [ -f "$tmp/win/chisel.exe" ]; then
    cp "$tmp/win/chisel.exe" "$dest"
  else
    find "$tmp/win" -name 'chisel*.exe' -exec cp {} "$dest" \;
  fi
  chmod 0755 "$dest"
  test -f "$dest"
}

install_linux linux_amd64
install_linux linux_386
install_linux linux_arm64
install_windows

host_tag=""
case "$(uname -m)" in
  x86_64|amd64) host_tag=linux_amd64 ;;
  aarch64|arm64) host_tag=linux_arm64 ;;
  i386|i686) host_tag=linux_386 ;;
  *) echo "WARN: no native chisel for $(uname -m); using linux_amd64" >&2; host_tag=linux_amd64 ;;
esac

mkdir -p /usr/local/bin
rm -f /usr/local/bin/chisel
cp -f "${DROP}/chisel_${host_tag}" /usr/local/bin/chisel
chmod 0755 /usr/local/bin/chisel
# Older images used /opt/heimdall/proxy/chisel/ as a drop tree. Do not clobber it.
if [ ! -d "${PROXY}/chisel" ]; then
  cp -f "${DROP}/chisel_${host_tag}" "${PROXY}/chisel"
  chmod 0755 "${PROXY}/chisel"
fi
export PATH="/usr/local/bin:${PATH}"
hash -r 2>/dev/null || true

test -x /usr/local/bin/chisel
test -x "${DROP}/chisel_linux_amd64"
test -x "${DROP}/chisel_linux_386"
test -x "${DROP}/chisel_linux_arm64"
test -f "${DROP}/chisel_windows_amd64.exe"
/usr/local/bin/chisel --help >/dev/null 2>&1 || true
echo "chisel ok ver=${CHISEL_VER} host=${host_tag} bin=/usr/local/bin/chisel drop=${DROP}"
