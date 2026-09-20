#!/bin/bash
# sshpass + native SQL clients for intranet pivot (no servers).
# Called from overlay / unified / executor / incr Dockerfiles.
set -euo pipefail

# Install tools directly; do not propagate a host proxy.
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY=
export http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*" no_proxy="*"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  sshpass \
  proxychains4 \
  ripgrep \
  mariadb-client \
  postgresql-client \
  sqlite3
rm -rf /var/lib/apt/lists/*

# Debian mariadb-client usually ships `mysql`; keep a PATH alias if not.
if ! command -v mysql >/dev/null 2>&1; then
  if command -v mariadb >/dev/null 2>&1; then
    ln -sfn "$(command -v mariadb)" /usr/local/bin/mysql
  else
    echo "mysql/mariadb client missing after apt" >&2
    exit 1
  fi
fi

command -v sshpass
command -v proxychains4
command -v rg
command -v mysql
command -v psql
command -v sqlite3
sshpass -V >/dev/null
mysql --version >/dev/null
psql --version >/dev/null
sqlite3 -version >/dev/null

# Older console images still ship dirsearch dicc.txt (~10k). Drop it here too.
if [ -d /opt/heimdall/vendor/dirscan ]; then
  find /opt/heimdall/vendor/dirscan -type f -iname 'dicc.txt' -delete
  while IFS= read -r db; do
    find "$db" -type f \( -name '*.txt' -o -name '*.lst' -o -name '*.dic' \) -delete
  done < <(find /opt/heimdall/vendor/dirscan -type d -name db)
fi

echo "net-db tools installed"
