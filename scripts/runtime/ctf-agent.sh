#!/usr/bin/env bash
# Agent entrypoint: Pi solver with optional Claude SDK fallback.
set -euo pipefail

# baked /opt/heimdall is fallback; do not shadow bind-mounted repo
export PATH="${PATH:-/usr/bin}:${HEIMDALL_REPO_ROOT:-/opt/heimdall}/bin:/usr/local/bin"
if [[ -d /opt/heimdall/proxy ]]; then
  export PATH="${PATH}:/opt/heimdall/proxy"
fi
export PYTHONPATH="${PYTHONPATH:+${PYTHONPATH}:}/opt/heimdall"
export HEIMDALL_WORKSPACE="${HEIMDALL_WORKSPACE:-/workspace}"
_HEIMDALL_ROOT="${HEIMDALL_REPO_ROOT:-/opt/heimdall}"
if [[ -z "${CHISEL_DROP:-}" ]]; then
  if [[ -d /opt/heimdall/proxy/chisel-drop ]]; then
    export CHISEL_DROP="/opt/heimdall/proxy/chisel-drop"
  elif [[ -d "${_HEIMDALL_ROOT}/proxy/chisel-drop" ]]; then
    export CHISEL_DROP="${_HEIMDALL_ROOT}/proxy/chisel-drop"
  fi
fi
# Leftover env from older images that shipped a private C2 client.
unset J35_API_URL J35_URL HEIMDALL_PORT_J35 2>/dev/null || true
# In-image leftover: /workspace is not the job dir. Never keep a global ledger.
if [[ "${HEIMDALL_WORKSPACE}" != "/workspace" ]]; then
  rm -f /workspace/hint.txt /workspace/flags.json
fi
export HEIMDALL_AGENT_BACKEND="${HEIMDALL_AGENT_BACKEND:-pi}"
export HOME="${HOME:-/root}"
export USER="${USER:-root}"
export LOGNAME="${LOGNAME:-root}"
# Claude Code allows bypassPermissions as root when it believes it is sandboxed.
export IS_SANDBOX="${IS_SANDBOX:-1}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
export PWTEST_CLI_GLOBAL_CONFIG="${PWTEST_CLI_GLOBAL_CONFIG:-/opt/heimdall}"

# isolate=gateway: own netns, send lab prefixes via the VPN sidecar.
if [[ -n "${HEIMDALL_VPN_GW:-}" ]] && command -v ip >/dev/null 2>&1; then
  ip route replace 10.0.0.0/8 via "${HEIMDALL_VPN_GW}" 2>/dev/null \
    || ip route add 10.0.0.0/8 via "${HEIMDALL_VPN_GW}" 2>/dev/null \
    || echo "WARN: could not add 10/8 via ${HEIMDALL_VPN_GW}" >&2
fi

# Default: stay root (docker exec / agent / Ghidra). Set HEIMDALL_DROP_PRIVS=1 to
# fall back to uid 1000 (legacy; Claude CLI historically blocked root bypass).
AGENT_UID="${HEIMDALL_AGENT_UID:-1000}"
AGENT_GID="${HEIMDALL_AGENT_GID:-1000}"

_is_http_observe_type() {
  case "$(printf '%s' "${1:-web}" | tr '[:upper:]' '[:lower:]')" in
    web|all|cve|ai|llm) return 0 ;;
    *) return 1 ;;
  esac
}

_challenge_type() {
  local t=""
  # Job payload is written before spawn; prefer it over a defaulted env.
  if [[ -f "${HEIMDALL_WORKSPACE}/input.json" ]]; then
    t="$(sed -n 's/.*"challenge_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${HEIMDALL_WORKSPACE}/input.json" | head -n1 | tr '[:upper:]' '[:lower:]')"
  fi
  if [[ -z "${t}" ]]; then
    t="$(printf '%s' "${HEIMDALL_CHALLENGE_TYPE:-}" | tr '[:upper:]' '[:lower:]')"
  fi
  if [[ -z "${t}" && -f "${HEIMDALL_WORKSPACE}/.heimdall/challenge_type" ]]; then
    t="$(tr '[:upper:]' '[:lower:]' <"${HEIMDALL_WORKSPACE}/.heimdall/challenge_type" | tr -d '[:space:]')"
  fi
  printf '%s' "${t}"
}

_is_loop_job() {
  case "$(printf '%s' "${HEIMDALL_LOOP:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# Advisor Pi + LLM inject on every challenge_type. HTTP tap stays
# _is_http_observe_type (web/all/cve/ai/llm). HEIMDALL_COACH=0 still disables the sidecar.
_should_start_observer() {
  return 0
}

# Ghidra/Java need a real passwd home (not uid 1000 with no entry → user.home=?).
# Must run as root *before* setpriv. Harmless if the account already exists.
_ensure_agent_identity() {
  local home uid gid gname uname curhome
  uid="${AGENT_UID:-1000}"
  gid="${AGENT_GID:-1000}"
  home="${HOME:-/root}"
  export HOME="${home}"
  mkdir -p "${home}" || true

  if [[ "$(id -u)" != "0" ]]; then
    export USER="${USER:-heimdall}"
    export LOGNAME="${LOGNAME:-${USER}}"
    return 0
  fi

  if ! getent group "${gid}" >/dev/null 2>&1; then
    groupadd -g "${gid}" heimdall 2>/dev/null \
      || grep -q "^heimdall:" /etc/group 2>/dev/null \
      || echo "heimdall:x:${gid}:" >> /etc/group
  fi

  if ! getent passwd "${uid}" >/dev/null 2>&1; then
    gname="$(getent group "${gid}" | cut -d: -f1 || true)"
    gname="${gname:-heimdall}"
    if ! useradd -u "${uid}" -g "${gname}" -d "${home}" -M -s /bin/bash heimdall 2>/dev/null; then
      if ! grep -q ":x:${uid}:" /etc/passwd 2>/dev/null; then
        echo "heimdall:x:${uid}:${gid}:Heimdall agent:${home}:/bin/bash" >> /etc/passwd
      fi
    fi
  else
    uname="$(getent passwd "${uid}" | cut -d: -f1 || true)"
    curhome="$(getent passwd "${uid}" | cut -d: -f6 || true)"
    if [[ -n "${uname}" && ( -z "${curhome}" || "${curhome}" == "/" ) ]]; then
      usermod -d "${home}" "${uname}" 2>/dev/null || true
    fi
  fi

  chown -R "${uid}:${gid}" "${home}" 2>/dev/null || true
  export USER="${USER:-heimdall}"
  export LOGNAME="${LOGNAME:-${USER}}"
}

# pyghidra / analyzeHeadless read GHIDRA_INSTALL_DIR. Ghidra 12+ wants JDK 21;
# never pin JAVA_HOME to the image's leftover OpenJDK 17.
_export_ghidra_env() {
  local home jdk ver
  home="${HOME:-/root}"
  mkdir -p "${home}" 2>/dev/null || true
  if [[ -d /opt/heimdall/ghidra ]]; then
    export GHIDRA_INSTALL_DIR="${GHIDRA_INSTALL_DIR:-/opt/heimdall/ghidra}"
    export GHIDRA_HOME="${GHIDRA_HOME:-${GHIDRA_INSTALL_DIR}}"
  fi
  case " ${JAVA_TOOL_OPTIONS:-} " in
    *" -Duser.home="*) ;;
    *) export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+${JAVA_TOOL_OPTIONS} }-Duser.home=${home}" ;;
  esac
  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then
    ver="$("${JAVA_HOME}/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -n1)"
    if [[ "${ver:-0}" -lt 21 ]]; then
      unset JAVA_HOME
    fi
  fi
  if [[ -z "${JAVA_HOME:-}" ]]; then
    for jdk in \
      /opt/heimdall/jdk-21 \
      /usr/lib/jvm/java-21-openjdk-amd64 \
      /usr/lib/jvm/java-21-openjdk-arm64 \
      /usr/lib/jvm/temurin-21-jdk-amd64
    do
      if [[ -x "${jdk}/bin/java" ]]; then
        export JAVA_HOME="${jdk}"
        break
      fi
    done
  fi
  # Always put JDK 21 first — login shells / image PATH may still prefer Debian 17.
  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then
    case ":${PATH}:" in
      *":${JAVA_HOME}/bin:"*) ;;
      *) export PATH="${JAVA_HOME}/bin:${PATH}" ;;
    esac
  fi
  # Extra JREs live beside the default; never prepend them over JAVA_HOME.
  if [[ -x /opt/heimdall/jdk-8/bin/java ]]; then
    export JAVA8_HOME="${JAVA8_HOME:-/opt/heimdall/jdk-8}"
  fi
  if [[ -x /opt/heimdall/jdk-11/bin/java ]]; then
    export JAVA11_HOME="${JAVA11_HOME:-/opt/heimdall/jdk-11}"
  fi
  if [[ -x /opt/heimdall/jdk-21/bin/java ]]; then
    export JAVA21_HOME="${JAVA21_HOME:-/opt/heimdall/jdk-21}"
  fi
}

_drop_privileges_if_root() {
  if [[ "$(id -u)" != "0" ]]; then
    return 0
  fi
  _ensure_agent_identity
  _export_ghidra_env
  mkdir -p "${HOME}" "${HEIMDALL_WORKSPACE}/.heimdall"
  # Fix bind-mount ownership from earlier root runs (esp. Windows Docker)
  chown -R "${AGENT_UID}:${AGENT_GID}" "${HEIMDALL_WORKSPACE}" 2>/dev/null || true
  chown -R "${AGENT_UID}:${AGENT_GID}" "${HOME}" 2>/dev/null || true
  chmod -R u+rwX "${HEIMDALL_WORKSPACE}" 2>/dev/null || true

  # Web HTTP tap needs NET_RAW; start as root, then exec drops this shell.
  _start_http_tap_root

  # passwd/group already created above — Java/Ghidra need the name+home.
  if command -v setpriv >/dev/null 2>&1; then
    export HOME USER LOGNAME
    exec setpriv --reuid="${AGENT_UID}" --regid="${AGENT_GID}" --clear-groups -- "$0" "$@"
  fi
  local uname
  uname="$(getent passwd "${AGENT_UID}" | cut -d: -f1 || true)"
  uname="${uname:-heimdall}"
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u "${uname}" --preserve-environment -- "$0" "$@"
  fi
  if command -v su >/dev/null 2>&1; then
    exec su -s /bin/bash "${uname}" -c "export HOME='${HOME}'; cd '${HEIMDALL_WORKSPACE}'; exec \"$0\""
  fi
  echo "WARN: cannot drop root; Claude bypassPermissions may fail" >&2
}

_prepare_as_root() {
  export HOME="${HOME:-/root}"
  export USER="${USER:-root}"
  export LOGNAME="${LOGNAME:-root}"
  export IS_SANDBOX="${IS_SANDBOX:-1}"
  mkdir -p "${HOME}" "${HEIMDALL_WORKSPACE}/.heimdall"
  chmod -R u+rwX "${HEIMDALL_WORKSPACE}" 2>/dev/null || true
  _export_ghidra_env
  _start_http_tap_root
}

# Prefer TS dist wrappers, then heimdall-run.
_pick_http_tap_cmd() {
  _TAP_CMD=()
  local root="${_HEIMDALL_ROOT:-/opt/heimdall}"
  if [[ -f "${root}/dist/taps/http-tap.js" && -f "${root}/bin/heimdall-http-tap" ]]; then
    _TAP_CMD=("${root}/bin/heimdall-http-tap")
    return 0
  fi
  if [[ -f /opt/heimdall/dist/taps/http-tap.js && -f "${_HEIMDALL_ROOT}/bin/heimdall-http-tap" ]]; then
    _TAP_CMD=("${_HEIMDALL_ROOT}/bin/heimdall-http-tap")
    return 0
  fi
  if [[ -f "${root}/dist/taps/http-tap.js" && -f "${root}/bin/heimdall-run" ]]; then
    _TAP_CMD=("${root}/bin/heimdall-run" dist/taps/http-tap.js)
    return 0
  fi
  echo "WARN: heimdall-http-tap missing (npm run build)" >&2
  return 1
}

# Root-only (before setpriv). Re-exec as uid 1000 must not start this again.
_start_http_tap_root() {
  if [[ "$(id -u)" != "0" ]]; then
    return 0
  fi
  if [[ "${HEIMDALL_DISABLE_HTTP_TAP:-}" == "1" ]]; then
    return 0
  fi
  local ctype
  ctype="$(printf '%s' "${HEIMDALL_CHALLENGE_TYPE:-web}" | tr '[:upper:]' '[:lower:]')"
  if ! _is_http_observe_type "${ctype}"; then
    return 0
  fi
  if [[ -z "${CONTAINER_ADDR:-}" ]]; then
    echo "WARN: http_tap skip (empty CONTAINER_ADDR)"
    return 0
  fi
  if ! _pick_http_tap_cmd; then
    echo "WARN: http_tap script missing"
    return 0
  fi
  mkdir -p "${HEIMDALL_WORKSPACE}/.heimdall/traffic"
  chmod 0777 "${HEIMDALL_WORKSPACE}/.heimdall/traffic" 2>/dev/null || true
  rm -f "${HEIMDALL_WORKSPACE}/.heimdall/http_tap.stop" 2>/dev/null || true
  # Default: run tap as root (same as agent). Legacy drop-priv keeps NET_RAW via setpriv.
  if [[ "${HEIMDALL_DROP_PRIVS:-0}" == "1" ]] \
     && command -v setpriv >/dev/null 2>&1 \
     && setpriv --help 2>&1 | grep -q -- '--ambient-caps'; then
    chown "${AGENT_UID}:${AGENT_GID}" "${HEIMDALL_WORKSPACE}/.heimdall/traffic" 2>/dev/null || true
    setpriv --reuid="${AGENT_UID}" --regid="${AGENT_GID}" --clear-groups \
      --inh-caps=+net_raw --ambient-caps=+net_raw -- \
      "${_TAP_CMD[@]}" \
      >>"${HEIMDALL_WORKSPACE}/.heimdall/http_tap.log" 2>&1 &
  else
    "${_TAP_CMD[@]}" \
      >>"${HEIMDALL_WORKSPACE}/.heimdall/http_tap.log" 2>&1 &
  fi
  echo $! >"${HEIMDALL_WORKSPACE}/.heimdall/http_tap.pid" 2>/dev/null || true
  echo "http_tap started pid=$!"
}

if [[ "${HEIMDALL_DROP_PRIVS:-0}" == "1" ]]; then
  _drop_privileges_if_root "$@"
  _ensure_agent_identity
  _export_ghidra_env
else
  _prepare_as_root
fi

mkdir -p "${HOME}" 2>/dev/null || true
mkdir -p "${HEIMDALL_WORKSPACE}/.heimdall" 2>/dev/null || true
mkdir -p "${HEIMDALL_WORKSPACE}/.heimdall/claude" 2>/dev/null || true
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HEIMDALL_WORKSPACE}/.heimdall/claude}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-${HEIMDALL_WORKSPACE}/.heimdall/pi}"
export PI_OFFLINE="${PI_OFFLINE:-1}"
mkdir -p "${CLAUDE_CONFIG_DIR}" "${PI_CODING_AGENT_DIR}" 2>/dev/null || true
# Per-run clock for delayed platform hint (do not reuse a previous job's stamp).
date +%s >"${HEIMDALL_WORKSPACE}/.heimdall/started_at" 2>/dev/null || true
# Playwright config: prefer $HOME so we can add --disable-http2 without writing the image.
_ensure_playwright_http1() {
  local dest_dir dest
  dest_dir="${HOME}/.playwright"
  dest="${dest_dir}/cli.config.json"
  mkdir -p "${dest_dir}"
  DEST="${dest}" node -e '
const fs = require("fs");
const dest = process.env.DEST;
const src = "/opt/heimdall/.playwright/cli.config.json";
let data = {};
for (const cand of [dest, src]) {
  try { data = JSON.parse(fs.readFileSync(cand, "utf8")); break; } catch {}
}
const browser = data.browser = data.browser || {};
const launch = browser.launchOptions = browser.launchOptions || {};
const args = (launch.args || []).map(String);
if (!args.includes("--disable-http2")) args.push("--disable-http2");
launch.args = args;
try { fs.mkdirSync(require("path").dirname(dest), { recursive: true }); fs.writeFileSync(dest, JSON.stringify(data, null, 2) + "\n"); } catch {}
' >/dev/null 2>&1 || printf '%s\n' '{"browser":{"launchOptions":{"args":["--disable-http2"]}}}' >"${dest}" 2>/dev/null || true
  printf '%s\n' "${HOME}"
}
_pw_home="$(_ensure_playwright_http1 2>/dev/null || echo "${HOME}")"
if [[ -f "${_pw_home}/.playwright/cli.config.json" ]]; then
  export PWTEST_CLI_GLOBAL_CONFIG="${_pw_home}"
fi

cd "${HEIMDALL_WORKSPACE}"

_job_hash_port() {
  local base="$1"
  local job="${HEIMDALL_JOB_ID:-default}"
  local digest n
  digest="$(printf '%s' "${job}" | sha256sum | awk '{print $1}')"
  n=$((16#${digest:0:4}))
  echo $((base + n % 1000))
}

# Solver talks to the target directly. Never inherit a host/Docker HTTP_PROXY.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY FTP_PROXY http_proxy https_proxy all_proxy ftp_proxy 2>/dev/null || true
export HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= FTP_PROXY= http_proxy= https_proxy= all_proxy= ftp_proxy=
export NO_PROXY="*"
export no_proxy="${NO_PROXY}"

# Per-job LLM tap (web only). Never reuse another job's listener.
_llm_tap_port() {
  _job_hash_port 18000
}

_start_llm_tap() {
  local ctype
  ctype="$(printf '%s' "${HEIMDALL_CHALLENGE_TYPE:-web}" | tr '[:upper:]' '[:lower:]')"
  if ! _should_start_observer "${ctype}"; then
    return 1
  fi
  if [[ "${HEIMDALL_DISABLE_LLM_TAP:-}" == "1" ]]; then
    return 1
  fi
  if ! command -v heimdall-llm-tap >/dev/null 2>&1; then
    return 1
  fi
  if [[ -z "${HEIMDALL_LLM_UPSTREAM:-}" ]]; then
    export HEIMDALL_LLM_UPSTREAM="${ANTHROPIC_BASE_URL:-}"
  fi
  if [[ -z "${HEIMDALL_LLM_UPSTREAM:-}" ]]; then
    echo "WARN: llm_tap skip (no ANTHROPIC_BASE_URL)"
    return 1
  fi
  local port
  port="${HEIMDALL_LLM_TAP_PORT:-}"
  if [[ -z "${port}" ]]; then
    port="$(_llm_tap_port)" || return 1
  fi
  export HEIMDALL_LLM_TAP_PORT="${port}"
  rm -f "${HEIMDALL_WORKSPACE}/.heimdall/llm_tap.json" 2>/dev/null || true
  if command -v heimdall-llm-tap >/dev/null 2>&1; then
    heimdall-llm-tap >>"${HEIMDALL_WORKSPACE}/.heimdall/llm_tap.log" 2>&1 &
  else
    echo "WARN: heimdall-llm-tap missing"
    return 1
  fi
  echo $! >"${HEIMDALL_WORKSPACE}/.heimdall/llm_tap.pid" 2>/dev/null || true
  local _i actual
  local body
  for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [[ -f "${HEIMDALL_WORKSPACE}/.heimdall/llm_tap.json" ]]; then
      actual="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${HEIMDALL_WORKSPACE}/.heimdall/llm_tap.json" | head -n1)"
      if [[ -n "${actual}" ]]; then
        body="$(curl -sf --max-time 1 "http://127.0.0.1:${actual}/tap/health" 2>/dev/null || true)"
        if printf '%s' "${body}" | grep -q '"ok"'; then
          if [[ -z "${HEIMDALL_JOB_ID:-}" ]] || printf '%s' "${body}" | grep -q "${HEIMDALL_JOB_ID}"; then
            export HEIMDALL_LLM_TAP_PORT="${actual}"
            export ANTHROPIC_BASE_URL="http://127.0.0.1:${actual}"
            export OPENAI_BASE_URL="${ANTHROPIC_BASE_URL}"
            export HEIMDALL_LLM_BASE_URL="${ANTHROPIC_BASE_URL}"
            echo "llm_tap enabled ${ANTHROPIC_BASE_URL} upstream=${HEIMDALL_LLM_UPSTREAM}"
            return 0
          fi
        fi
      fi
    fi
    sleep 0.2
  done
  echo "WARN: llm_tap not healthy; leaving ANTHROPIC_BASE_URL unchanged"
  return 1
}

_start_llm_tap || true

_install_web_hooks() {
  local ctype hookdir
  ctype="$(printf '%s' "${HEIMDALL_CHALLENGE_TYPE:-web}" | tr '[:upper:]' '[:lower:]')"
  if ! _is_http_observe_type "${ctype}"; then
    return 0
  fi
  hookdir="${HEIMDALL_WORKSPACE}/.heimdall/hooks"
  mkdir -p "${hookdir}"
  chmod +x "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_curl" \
           "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_playwright" 2>/dev/null || true
  ln -sfn "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_curl" "${hookdir}/curl"
  ln -sfn "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_playwright" "${hookdir}/playwright-cli"
  chmod +x "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_fuzz" \
           "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_bash" 2>/dev/null || true
  # Do not plant stubs for deleted scanners or dirsearch.
  # command -v on a stub looks like the tool is installed.
  local b real path_wo
  path_wo="$(printf '%s' "${PATH:-}" | tr ':' '\n' | grep -v -F "${hookdir}" | paste -sd: -)"
  for b in nuclei nikto \
           hashcat john hydra medusa patator jwt_tool jwt-cracker; do
    real="$(PATH="${path_wo}" command -v "${b}" 2>/dev/null || true)"
    if [[ -n "${real}" && -x "${real}" ]]; then
      ln -sfn "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_fuzz" "${hookdir}/${b}"
    fi
  done
  ln -sfn "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_bash" "${hookdir}/bash"
  export PATH="${hookdir}:${PATH}"
}

_strip_leftover_scan_dicts() {
  local vendor="${HEIMDALL_DIRSCAN_VENDOR:-/opt/heimdall/vendor/dirscan}"
  if [[ -d "${vendor}" ]]; then
    find "${vendor}" -type f -iname 'dicc.txt' -delete 2>/dev/null || true
    while IFS= read -r db; do
      find "${db}" -type f \( -name '*.txt' -o -name '*.lst' -o -name '*.dic' \) -delete 2>/dev/null || true
    done < <(find "${vendor}" -type d -name db 2>/dev/null || true)
  fi
}

_maybe_enable_mitm_ca() {
  if [[ "${HEIMDALL_HTTP_MITM:-}" != "1" ]]; then
    return 0
  fi
  local ctype ca
  ctype="$(printf '%s' "${HEIMDALL_CHALLENGE_TYPE:-web}" | tr '[:upper:]' '[:lower:]')"
  if ! _is_http_observe_type "${ctype}"; then
    return 0
  fi
  local d pem bundle
  d="${HEIMDALL_WORKSPACE}/.heimdall/mitm"
  mkdir -p "${d}"
  pem="${d}/ca.pem"
  if [[ ! -f "${pem}" ]]; then
    if ! command -v openssl >/dev/null 2>&1; then
      echo "WARN: http_mitm skip (openssl missing)"
      return 0
    fi
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "${d}/ca.key" -out "${pem}" \
      -subj "/CN=Heimdall Lab MITM CA" >/dev/null 2>&1 || {
      echo "WARN: http_mitm CA create failed"
      return 0
    }
    chmod 644 "${pem}" 2>/dev/null || true
    chmod 600 "${d}/ca.key" 2>/dev/null || true
  fi
  bundle="${d}/combined.pem"
  {
    cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true
    cat "${pem}"
  } >"${bundle}" 2>/dev/null || bundle=""
  if [[ -n "${pem}" && -f "${pem}" ]]; then
    export HEIMDALL_MITM_CA="${pem}"
    echo "http_mitm CA=${pem}"
  fi
  if [[ -n "${bundle}" && -f "${bundle}" ]]; then
    export SSL_CERT_FILE="${bundle}"
    export REQUESTS_CA_BUNDLE="${bundle}"
    export CURL_CA_BUNDLE="${bundle}"
  fi
}

_start_web_coach() {
  # Loop keeps the Pi observer (DeepSeek / HEIMDALL_COACH_*). The solver
  # overlay to Kimi must not skip this sidecar — hint ticks rewrite LOCK.
  if [[ "${HEIMDALL_COACH:-1}" == "0" ]]; then
    return 1
  fi
  if _is_loop_job; then
    echo "observer_pi on (loop)"
  fi
  local ctype
  ctype="$(printf '%s' "${HEIMDALL_CHALLENGE_TYPE:-web}" | tr '[:upper:]' '[:lower:]')"
  if ! _should_start_observer "${ctype}"; then
    echo "observer_pi skip (type=${ctype})"
    return 1
  fi
  if command -v heimdall-observer >/dev/null 2>&1; then
    heimdall-observer >>"${HEIMDALL_WORKSPACE}/.heimdall/web_coach.log" 2>&1 &
    echo $! >"${HEIMDALL_WORKSPACE}/.heimdall/web_coach.pid" 2>/dev/null || true
    echo "observer_pi started pid=$! script=heimdall-observer model=${HEIMDALL_COACH_MODEL:-}"
    return 0
  fi
  echo "WARN: heimdall-observer missing (npm run build)"
  return 1
}

_maybe_enable_mitm_ca
_start_web_coach || true

_cleanup_observe() {
  local f pid
  # Root tap may ignore SIGTERM from uid 1000; the stop file always works.
  touch "${HEIMDALL_WORKSPACE}/.heimdall/http_tap.stop" 2>/dev/null || true
  for f in http_tap.pid llm_tap.pid web_coach.pid; do
    if [[ -f "${HEIMDALL_WORKSPACE}/.heimdall/${f}" ]]; then
      pid="$(cat "${HEIMDALL_WORKSPACE}/.heimdall/${f}" 2>/dev/null || true)"
      if [[ -n "${pid}" ]]; then
        kill "${pid}" 2>/dev/null || true
      fi
    fi
  done
}
trap _cleanup_observe EXIT

echo "=== heimdall ctf-agent ==="
echo "UNIQUE_CODE=${UNIQUE_CODE:-}"
echo "ATTEMPT_N=${ATTEMPT_N:-1}"
echo "CONTAINER_ADDR=${CONTAINER_ADDR:-}"
echo "JOB_ID=${HEIMDALL_JOB_ID:-}"
echo "BACKEND=${HEIMDALL_AGENT_BACKEND}"
echo "IDENTITY=$(id -un 2>/dev/null || echo '?') uid=$(id -u) HOME=${HOME:-} drop_privs=${HEIMDALL_DROP_PRIVS:-0}"
echo "GHIDRA_INSTALL_DIR=${GHIDRA_INSTALL_DIR:-}"
echo "JAVA_HOME=${JAVA_HOME:-}"
echo "HTTP_PROXY=${HTTP_PROXY:-}"
echo "NO_PROXY=${NO_PROXY:-}"
echo "CHISEL_DROP=${CHISEL_DROP:-}"
echo "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}"
echo "HEIMDALL_LLM_UPSTREAM=${HEIMDALL_LLM_UPSTREAM:-}"
echo "HEIMDALL_COACH_BASE_URL=${HEIMDALL_COACH_BASE_URL:-}"
echo "HEIMDALL_COACH_MODEL=${HEIMDALL_COACH_MODEL:-}"
echo "HEIMDALL_HTTP_MITM=${HEIMDALL_HTTP_MITM:-0}"
echo "PYTHONPATH=${PYTHONPATH}"

# Bind-mount may drop +x on Windows hosts
chmod +x "${_HEIMDALL_ROOT}/bin/heimdall-submit" \
         "${_HEIMDALL_ROOT}/bin/heimdall-goal" \
         "${_HEIMDALL_ROOT}/bin/heimdall-hint" \
         "${_HEIMDALL_ROOT}/bin/heimdall-challenge" \
         "${_HEIMDALL_ROOT}/bin/heimdall-http-tap" \
         "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_curl" \
         "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_playwright" \
         "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_fuzz" \
         "${_HEIMDALL_ROOT}/scripts/runtime/heimdall_hook_bash" 2>/dev/null || true

if [[ -f "${HEIMDALL_WORKSPACE}/input.json" ]]; then
  echo "--- input.json ---"
  cat "${HEIMDALL_WORKSPACE}/input.json" || true
  echo
fi

# Drop leftover scanner dicts on older local images (overlay already strips).
_strip_leftover_scan_dicts

# Hook PATH after observer start so heimdall-observer's `env bash` is the real bash.
_install_web_hooks

# Regular Pi and loop Claude SDK both use heimdall-agent.
# HEIMDALL_AGENT_BIN overrides the binary entirely.
_run_solver() {
  if [[ -n "${HEIMDALL_AGENT_BIN:-}" ]]; then
    echo "Starting agent HEIMDALL_AGENT_BIN=${HEIMDALL_AGENT_BIN}"
    set +e
    # shellcheck disable=SC2086
    ${HEIMDALL_AGENT_BIN}
    rc=$?
    set -e
    echo "=== agent finished rc=${rc} ==="
    exit "${rc}"
  fi

  local backend
  backend="$(printf '%s' "${HEIMDALL_AGENT_BACKEND:-pi}" | tr '[:upper:]' '[:lower:]')"

  if command -v heimdall-agent >/dev/null 2>&1; then
    echo "Starting heimdall-agent (backend=${backend})..."
    set +e
    # PATH may contain a `bash` hook. Don't let `#!/usr/bin/env bash` recurse.
    if [[ -x /bin/bash ]]; then
      /bin/bash "$(command -v heimdall-agent)"
    else
      heimdall-agent
    fi
    rc=$?
    set -e
    echo "=== agent finished rc=${rc} ==="
    exit "${rc}"
  fi
  echo "FATAL: heimdall-agent missing (npm run build)" >&2
  exit 2
}

_run_solver
