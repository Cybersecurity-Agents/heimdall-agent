# syntax=docker/dockerfile:1.7
# Public, clean build. No previously built Heimdall image is an input.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ARG DOCKER_CLI_IMAGE=docker:29.3.0-cli@sha256:067c301efe497cd5d174d468b7b3422a485ae4aca8f7ec1ffd4655c9fa383af2
ARG RUST_BUILD_IMAGE=rust:1.85.1-slim-bookworm@sha256:9f841bbe9e7d8e37ceb96ed907265a3a0df7f44e3737d0b100e7907a679acb36
FROM ${NODE_IMAGE} AS app-build
WORKDIR /opt/heimdall
COPY package.json package-lock.json ./
COPY console/package.json console/package-lock.json ./console/
RUN npm ci && npm --prefix console ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY scripts/ ./scripts/
COPY resources/ ./resources/
COPY deploy/vpn/ ./deploy/vpn/
COPY deploy/unified/ ./deploy/unified/
COPY console/ ./console/
COPY tools.env.example.yaml ./
RUN npm run build && npm prune --omit=dev \
 && rm -rf src console/node_modules console/src /root/.npm

FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${RUST_BUILD_IMAGE} AS rust-build
FROM ${DEBIAN_IMAGE} AS vpn
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash ca-certificates openvpn iproute2 iptables \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/vpn/entrypoint.sh /usr/local/bin/heimdall-vpn
RUN chmod 0755 /usr/local/bin/heimdall-vpn
LABEL org.opencontainers.image.source="https://github.com/QiantangCredit/heimdall-agent" \
      org.opencontainers.image.title="Heimdall VPN"
ENTRYPOINT ["/usr/local/bin/heimdall-vpn"]

# Match the established Debian 12 runtime; Node and npm are already included.
FROM ${NODE_IMAGE} AS tools
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PWTEST_CLI_GLOBAL_CONFIG=/opt/heimdall \
    GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra GHIDRA_HOME=/opt/heimdall/ghidra \
    JAVA_HOME=/opt/heimdall/jdk-21
COPY scripts/install/public/system.sh /tmp/heimdall-system.sh
RUN bash /tmp/heimdall-system.sh && rm /tmp/heimdall-system.sh
COPY resources/toolkits/downloads.lock.json /opt/heimdall/resources/toolkits/downloads.lock.json
COPY scripts/install/public/assets.sh scripts/install/public/fetch.py /opt/heimdall/scripts/install/public/
RUN --mount=type=cache,target=/var/cache/heimdall-downloads,sharing=locked bash /opt/heimdall/scripts/install/public/assets.sh
COPY resources/toolkits/python-requirements.txt /opt/heimdall/resources/toolkits/python-requirements.txt
COPY scripts/install/public/python.sh /opt/heimdall/scripts/install/public/python.sh
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked bash /opt/heimdall/scripts/install/public/python.sh main
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked bash /opt/heimdall/scripts/install/public/python.sh android
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked bash /opt/heimdall/scripts/install/public/python.sh pyghidra
COPY scripts/install/public/browser.sh /opt/heimdall/scripts/install/public/browser.sh
RUN bash /opt/heimdall/scripts/install/public/browser.sh
COPY resources/toolkits/ad/ /opt/heimdall/resources/toolkits/ad/
COPY scripts/install/ad/ /opt/heimdall/scripts/install/ad/
COPY scripts/install/install-ad.sh /opt/heimdall/scripts/install/install-ad.sh
# Aardwolf needs Rust >=1.74. Mount the compiler only during the build so its
# toolchain and registry do not add another Rust installation to the image.
RUN --mount=type=bind,from=rust-build,source=/usr/local/cargo/bin,target=/usr/local/cargo/bin \
    --mount=type=bind,from=rust-build,source=/usr/local/rustup,target=/usr/local/rustup \
    --mount=type=cache,target=/var/cache/heimdall-cargo,sharing=locked \
    PATH="/usr/local/cargo/bin:$PATH" RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/var/cache/heimdall-cargo \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=5 \
    HEIMDALL_STRICT_TOOLS=1 bash /opt/heimdall/scripts/install/install-ad.sh \
 && /opt/heimdall/ad/bin/pip freeze > /opt/heimdall/tool-versions/ad.txt \
 && command -v nxc && command -v certipy && command -v secretsdump.py
COPY scripts/install/install-dirscan.sh scripts/install/install-chisel.sh /opt/heimdall/scripts/install/
COPY scripts/runtime/dirscan-wrap.sh /opt/heimdall/scripts/runtime/dirscan-wrap.sh
RUN bash /opt/heimdall/scripts/install/install-dirscan.sh \
 && bash /opt/heimdall/scripts/install/install-chisel.sh \
 && rm -rf /root/.cache /root/.npm \
 && dpkg-query -W > /opt/heimdall/tool-versions/dpkg.txt

FROM tools AS runtime
WORKDIR /opt/heimdall
COPY --from=app-build /opt/heimdall/ /opt/heimdall/
ENV HEIMDALL_AGENT_BACKEND=pi PI_OFFLINE=1 \
    PYTHONPATH=/opt/heimdall \
    PATH=/opt/heimdall/bin:/opt/heimdall/node_modules/.bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
# Omit SQLMap's million-entry dictionary from the final runtime.
RUN rm -f /usr/share/sqlmap/data/txt/wordlist.tx_ \
 && bash scripts/install/install-runtime-tools.sh \
 && bash scripts/install/install-cve-poc.sh \
 && install -m 0755 scripts/runtime/heapdump-extract /usr/local/bin/heapdump-extract \
 && install -m 0755 scripts/runtime/ldaps-wrap /usr/local/bin/ldaps-wrap \
 && chmod 0755 scripts/runtime/*.sh deploy/unified/entrypoint.sh \
 && node scripts/build/check-tools.mjs --write-marker
LABEL org.opencontainers.image.source="https://github.com/QiantangCredit/heimdall-agent" \
      org.opencontainers.image.title="Heimdall full tools runtime" \
      org.heimdall.tools.profile="full"

FROM runtime AS executor
WORKDIR /workspace
ENTRYPOINT ["/opt/heimdall/scripts/runtime/ctf-agent.sh"]

FROM runtime AS all-in-one
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ENV HEIMDALL_AGENT_RUNTIME=local HEIMDALL_OBSERVE=1
EXPOSE 8700
ENTRYPOINT ["/opt/heimdall/deploy/unified/entrypoint.sh"]
