#!/usr/bin/env bash
# TSec OpenVPN client for Heimdall sidecar (shared with agent containers).
set -euo pipefail

CFG="${HEIMDALL_VPN_CONFIG:-/vpn/client.ovpn}"
LOG="${HEIMDALL_VPN_LOG:-/var/log/openvpn-client.log}"

# Lab + OVPN server must never go through a leftover host HTTP proxy.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY FTP_PROXY http_proxy https_proxy all_proxy ftp_proxy 2>/dev/null || true
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY= http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*" no_proxy="*"

if [[ ! -f "${CFG}" ]]; then
  echo "ERROR: OpenVPN config missing: ${CFG}" >&2
  echo "Mount *.ovpn to /vpn/client.ovpn (see docker.vpn.config in config.yaml)" >&2
  exit 2
fi

if [[ ! -c /dev/net/tun ]] && [[ ! -e /dev/net/tun ]]; then
  echo "WARN: /dev/net/tun not present — creating node (needs NET_ADMIN)" >&2
  mkdir -p /dev/net
  # mknod may fail without privilege; Docker --device usually supplies tun
  mknod /dev/net/tun c 10 200 2>/dev/null || true
fi

if ! command -v openvpn >/dev/null 2>&1; then
  echo "ERROR: openvpn binary not found in image" >&2
  exit 2
fi

echo "=== heimdall tsec-vpn ==="
echo "config=${CFG}"
echo "log=${LOG}"
ip -br link 2>/dev/null || true

# --data-ciphers / compat already in many TSec .ovpn files
# Keep process in foreground so Docker tracks health via status.
mkdir -p "$(dirname "${LOG}")" 2>/dev/null || true

if [[ "${HEIMDALL_VPN_ISOLATE:-}" == "gateway" ]]; then
  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
  cat >/tmp/heimdall-vpn-up.sh <<'EOS'
#!/bin/sh
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
dev=$(ip -o link 2>/dev/null | awk -F': ' '/tun|tap/{print $2; exit}')
dev=${dev:-tun0}
if command -v iptables >/dev/null 2>&1; then
  iptables -t nat -C POSTROUTING -o "$dev" -j MASQUERADE 2>/dev/null \
    || iptables -t nat -A POSTROUTING -o "$dev" -j MASQUERADE
  iptables -C FORWARD -i eth0 -o "$dev" -j ACCEPT 2>/dev/null \
    || iptables -A FORWARD -i eth0 -o "$dev" -j ACCEPT
  iptables -C FORWARD -i "$dev" -o eth0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
    || iptables -A FORWARD -i "$dev" -o eth0 -m state --state RELATED,ESTABLISHED -j ACCEPT
fi
EOS
  chmod +x /tmp/heimdall-vpn-up.sh
  exec openvpn \
    --config "${CFG}" \
    --verb "${HEIMDALL_VPN_VERB:-3}" \
    --log-append "${LOG}" \
    --writepid /var/run/openvpn-client.pid \
    --suppress-timestamps \
    --script-security 2 \
    --up /tmp/heimdall-vpn-up.sh \
    --up-restart
fi

exec openvpn \
  --config "${CFG}" \
  --verb "${HEIMDALL_VPN_VERB:-3}" \
  --log-append "${LOG}" \
  --writepid /var/run/openvpn-client.pid \
  --suppress-timestamps
