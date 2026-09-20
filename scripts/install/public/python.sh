#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/heimdall
export PIP_DEFAULT_TIMEOUT="${PIP_DEFAULT_TIMEOUT:-120}" PIP_RETRIES="${PIP_RETRIES:-5}"
profile=${1:-all}
case "$profile" in all|main|android|pyghidra) ;; *) echo "Unknown Python profile: $profile" >&2; exit 2 ;; esac
if [ "$profile" = all ] || [ "$profile" = main ]; then
/usr/bin/python3 -m venv "$ROOT/python"
"$ROOT/python/bin/pip" install -r "$ROOT/resources/toolkits/python-requirements.txt"
# Explicit wrappers preserve the venv when tools invoke python3 via /usr/bin/env.
for pair in 'python:python3' 'python3:python3' 'pip:pip' 'pip3:pip'; do
  name=${pair%%:*}; command=${pair#*:}
  printf '#!/bin/sh\nexec /opt/heimdall/python/bin/%s "$@"\n' "$command" > "/usr/local/bin/$name"
  chmod 0755 "/usr/local/bin/$name"
done
for name in pwn checksec ROPgadget; do ln -s "$ROOT/python/bin/$name" "/usr/local/bin/$name"; done
"$ROOT/python/bin/pip" freeze > "$ROOT/tool-versions/python.txt"
fi
# Independent dependency graphs and build layers keep retries local to a kit.
for item in 'android:androguard==4.1.4:androguard' 'pyghidra:pyghidra-mcp==0.2.5:pyghidra-mcp'; do
  IFS=: read -r name package command <<< "$item"
  if [ "$profile" != all ] && [ "$profile" != "$name" ]; then continue; fi
  /usr/bin/python3 -m venv "$ROOT/$name"
  "$ROOT/$name/bin/pip" install "$package"
  "$ROOT/$name/bin/pip" freeze > "$ROOT/tool-versions/$name.txt"
  ln -s "$ROOT/$name/bin/$command" "/usr/local/bin/$command"
done
