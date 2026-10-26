#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80heimdall-downloads
# The first public full image is amd64: x86 pwn needs 32-bit libc and multilib.
test "$(dpkg --print-architecture)" = amd64
dpkg --add-architecture i386
mirror="${HEIMDALL_APT_MIRROR:-http://deb.debian.org}"
[[ "$mirror" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || { echo 'Invalid HEIMDALL_APT_MIRROR' >&2; exit 1; }
sed -i "s|http://deb.debian.org|$mirror|g" /etc/apt/sources.list.d/debian.sources
apt-get update --error-on=any
# node:bookworm-slim does not include the system CA bundle. Bootstrap it from
# Debian's signed repository before using HTTPS for the remaining packages.
apt-get install -y --no-install-recommends ca-certificates
sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources
apt-get install -y --no-install-recommends \
  bash ca-certificates tzdata curl wget git openssh-client \
  coreutils findutils grep sed gawk tar gzip xz-utils unzip zip p7zip-full \
  file tree less jq vim-tiny procps psmisc lsof iproute2 iputils-ping \
  python3 python3-pip python3-venv python3-dev build-essential pkg-config \
  libssl-dev libffi-dev libxml2-dev libxslt1-dev libpcap-dev \
  passwd util-linux tmux rlwrap netcat-openbsd socat nmap openssl whois dnsutils \
  tcpdump tshark tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim imagemagick \
  libimage-exiftool-perl gdb gdbserver gdb-multiarch binutils-multiarch ruby ruby-dev \
  cmake ninja-build nasm xxd qemu-user gcc-multilib g++-multilib libc6-dbg \
  libc6:i386 libstdc++6:i386 libgcc-s1:i386 libc6-dbg:i386 libcapstone-dev \
  patchelf ltrace strace sqlmap whatweb binwalk foremost steghide fcrackzip john \
  sshpass proxychains4 ripgrep mariadb-client postgresql-client sqlite3 \
  maven openvpn iptables rustc cargo
rm -rf /var/lib/apt/lists/*
