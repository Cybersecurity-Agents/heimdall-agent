#!/bin/bash
# Bake nxc + Impacket + Certipy + proxychains4 into the overlay.
# Isolated venv at /opt/heimdall/ad — never shadow ProjectDiscovery httpx.
set -euo pipefail

AD_SRC="${HEIMDALL_AD_SRC:-/opt/heimdall/scripts/install/ad}"
INSTALL="${AD_SRC}/install.sh"

# Install tools directly; do not propagate a host proxy.
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY=
export http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*" no_proxy="*"

if [ ! -x "$INSTALL" ]; then
  echo "missing AD installer: $INSTALL" >&2
  exit 1
fi

command -v python3 >/dev/null
command -v git >/dev/null
python3 -c "import venv"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends proxychains4
rm -rf /var/lib/apt/lists/*

if [ "${HEIMDALL_STRICT_TOOLS:-0}" != 1 ] && ! curl -fsS --connect-timeout 8 --max-time 15 https://github.com >/dev/null 2>&1; then
  echo "WARN: GitHub unreachable; AD_PYPI_ONLY=1 (no nxc)" >&2
  export AD_PYPI_ONLY=1
fi

"$INSTALL"

if [ "${AD_PYPI_ONLY:-}" != 1 ] && ! command -v nxc >/dev/null 2>&1 && ! command -v rustc >/dev/null 2>&1; then
  RUSTUP_HOME="${RUSTUP_HOME:-/tmp/heimdall-rustup}"
  CARGO_HOME="${CARGO_HOME:-/tmp/heimdall-cargo}"
  if curl --proto "=https" --tlsv1.2 -fsS --retry 3 --retry-delay 2 \
      https://sh.rustup.rs -o /tmp/rustup-init.sh; then
    RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
      sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable --no-modify-path
    export RUSTUP_HOME CARGO_HOME
    export PATH="${CARGO_HOME}/bin:${PATH}"
    "$INSTALL" || true
    rm -rf "$RUSTUP_HOME" "$CARGO_HOME"
  else
    echo "WARN: rustup unreachable; keeping Impacket/Certipy fallback (no nxc)" >&2
  fi
  rm -f /tmp/rustup-init.sh
fi

command -v certipy
command -v secretsdump.py
command -v GetUserSPNs.py
command -v GetNPUsers.py
command -v proxychains4
if command -v nxc >/dev/null 2>&1; then
  nxc --help >/dev/null
else
  echo "WARN: nxc missing (NetExec needs GitHub). Impacket + certipy are installed." >&2
fi
certipy --help >/dev/null
secretsdump.py --help >/dev/null
proxychains4 -h >/dev/null 2>&1 || proxychains4 --help >/dev/null 2>&1 || true

httpx_bin="$(command -v httpx)"
test -n "$httpx_bin"
if head -c 120 "$httpx_bin" | grep -qi python; then
  echo "httpx was shadowed by PyPI: $httpx_bin" >&2
  exit 1
fi
test ! -L /usr/local/bin/httpx || test "$(readlink -f /usr/local/bin/httpx)" = "$(readlink -f "$httpx_bin")"

echo "ad-kit ok nxc=$(command -v nxc) certipy=$(command -v certipy) httpx=$httpx_bin"
