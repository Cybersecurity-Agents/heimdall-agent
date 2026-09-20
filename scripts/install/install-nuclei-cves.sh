#!/bin/bash
# Official projectdiscovery/nuclei-templates http/cves (full year tree, not a curated subset).
# Agent greps this dir; do not print or copy a catalog.
set -euo pipefail

DEST="${HEIMDALL_NUCLEI_TEMPLATES:-/root/nuclei-templates}"
URL="${NUCLEI_TEMPLATES_URL:-https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.tar.gz}"
CVES="$DEST/http/cves"

# Install tools directly; do not propagate a host proxy.
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY=
export http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*" no_proxy="*"

count_yaml() {
  local root="$1"
  find "$root" -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | wc -l
}

if [ -d "$CVES" ]; then
  n="$(count_yaml "$CVES")"
  if [ "$n" -gt 100 ]; then
    echo "nuclei http/cves already $n files -> $CVES"
    exit 0
  fi
fi

command -v curl >/dev/null
command -v tar >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "fetch $URL"
curl -fsSL --retry 4 --retry-delay 2 -A "heimdall-nuclei-cves" -o "$tmp/nt.tgz" "$URL"
mkdir -p "$tmp/src"
tar -xzf "$tmp/nt.tgz" -C "$tmp/src"
src="$(find "$tmp/src" -type d -path '*/http/cves' | head -n 1)"
if [ -z "$src" ] || [ ! -d "$src" ]; then
  echo "tarball missing http/cves" >&2
  exit 1
fi

n="$(count_yaml "$src")"
if [ "$n" -lt 100 ]; then
  echo "http/cves too small: $n" >&2
  exit 1
fi

mkdir -p "$DEST/http"
rm -rf "$CVES"
cp -a "$src" "$CVES"
printf 'upstream=%s\npath=http/cves\nfiles=%s\n' \
  "https://github.com/projectdiscovery/nuclei-templates" "$n" \
  >"$DEST/SOURCE.txt"
echo "nuclei http/cves $n files -> $CVES"
test -d "$CVES"
