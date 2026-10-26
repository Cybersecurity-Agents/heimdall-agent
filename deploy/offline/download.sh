#!/usr/bin/env bash
# Download a versioned GitHub Release and run its verified offline installer.
set -euo pipefail

release="${HEIMDALL_RELEASE:-offline-20261026-0a711bb}"
if [[ ! "$release" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  printf 'Invalid HEIMDALL_RELEASE\n' >&2
  exit 1
fi
if [[ -n "${HEIMDALL_PORT:-}" ]] && { [[ ! "$HEIMDALL_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$HEIMDALL_PORT < 1 || 10#$HEIMDALL_PORT > 65535 )); }; then
  printf 'HEIMDALL_PORT must be between 1 and 65535\n' >&2
  exit 1
fi
for command in curl tar docker; do command -v "$command" >/dev/null; done
docker info >/dev/null
docker compose version >/dev/null
if command -v sha256sum >/dev/null; then
  hash_command=(sha256sum)
else
  command -v shasum >/dev/null
  hash_command=(shasum -a 256)
fi

mkdir -p -- "${HEIMDALL_INSTALL_DIR:-heimdall-offline}"
cd -- "${HEIMDALL_INSTALL_DIR:-heimdall-offline}"
base="https://github.com/QiantangCredit/heimdall-agent/releases/download/$release"
archive=heimdall-agent-linux-amd64.tar
parts=("$archive.part01" "$archive.part02")
curl --fail --location --retry 3 --connect-timeout 20 "$base/SHA256SUMS" -o SHA256SUMS.download
mv SHA256SUMS.download SHA256SUMS

expected_hash() {
  local value
  value="$(awk -v name="$1" '$2 == name { print $1 }' SHA256SUMS)"
  if [[ ! "$value" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'Missing or invalid checksum: %s\n' "$1" >&2
    return 1
  fi
  printf '%s' "$value"
}
valid_file() {
  local expected="$1" path="$2" actual
  [[ -f "$path" ]] || return 1
  actual="$("${hash_command[@]}" "$path")"
  [[ "${actual%% *}" == "$expected" ]]
}

archive_hash="$(expected_hash "$archive")"
if ! valid_file "$archive_hash" "$archive"; then
  for part in "${parts[@]}"; do
    expected="$(expected_hash "$part")"
    if ! valid_file "$expected" "$part"; then
      curl --fail --location --retry 3 --connect-timeout 20 "$base/$part" -o "$part.download"
      valid_file "$expected" "$part.download" || { printf 'Checksum failed: %s\n' "$part" >&2; exit 1; }
      mv -- "$part.download" "$part"
    fi
  done
  cat -- "${parts[@]}" > "$archive.download"
  valid_file "$archive_hash" "$archive.download" || { printf 'Archive checksum failed\n' >&2; exit 1; }
  mv -- "$archive.download" "$archive"
fi

tar -xf "$archive"
cd heimdall-agent
# Preserve credentials and saved settings; remember the loaded image for later
# `docker compose up` commands as well as this initial installation.
umask 077
if [[ ! -e .env ]]; then cp .env.example .env; fi
set_env() {
  awk -v key="$1" -v value="$2" '
    index($0, key "=") == 1 { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' .env > .env.download
  mv .env.download .env
}
set_env HEIMDALL_IMAGE "$(cat image.txt)"
if [[ -n "${HEIMDALL_PORT:-}" ]]; then set_env HEIMDALL_PORT "$HEIMDALL_PORT"; fi
bash install.sh
printf '\n安装目录：%s\n' "$PWD"
printf '访问地址：http://127.0.0.1:%s\n' "${HEIMDALL_PORT:-$(awk -F= '$1 == "HEIMDALL_PORT" { print $2 }' .env)}"
