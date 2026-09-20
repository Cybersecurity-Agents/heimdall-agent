#!/usr/bin/env bash
set -euo pipefail
export PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT="${PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:-120000}"
npm install -g @playwright/cli@0.1.19
playwright-cli install-browser --with-deps chromium
mkdir -p /opt/heimdall/.playwright
cat > /opt/heimdall/.playwright/cli.config.json <<'JSON'
{"browser":{"browserName":"chromium","launchOptions":{"headless":true,"chromiumSandbox":false,"args":["--no-sandbox","--disable-dev-shm-usage","--no-proxy-server"]}}}
JSON
npm cache clean --force
rm -rf /var/lib/apt/lists/* /root/.cache
