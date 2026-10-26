#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
docker info >/dev/null
docker compose version >/dev/null
if command -v sha256sum >/dev/null; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi
docker load -i heimdall-image.tar.gz
export HEIMDALL_IMAGE
HEIMDALL_IMAGE="$(cat image.txt)"
# Give this single-model edition its own project and data volume.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-heimdall-agent}"
if [[ ! -e .env ]]; then
  umask 077
  cp .env.example .env
fi
docker compose -f compose.yaml up -d --no-build --pull never --wait
docker compose -f compose.yaml ps
printf '\nHeimdall 已启动；默认地址：http://127.0.0.1:8700\n请在设置页填写模型地址和 API Key。端口可在 .env 中修改。\n'
