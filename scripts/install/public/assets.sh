#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/heimdall
fetch() { /usr/bin/python3 "$ROOT/scripts/install/public/fetch.py" "$@"; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$ROOT/vendor" "$ROOT/tool-versions" "$ROOT/libc"
mkdir -p "$ROOT/third-party"
for name in httpx katana nuclei subfinder; do
  fetch "$name" "$work/$name.zip"
  mkdir "$work/$name"
  unzip -q "$work/$name.zip" -d "$work/$name"
  install -m 0755 "$work/$name/$name" "/usr/local/bin/$name"
  mkdir -p "$ROOT/third-party/$name"
  for notice in "$work/$name"/LICENSE* "$work/$name"/NOTICE*; do
    if [ -f "$notice" ]; then cp "$notice" "$ROOT/third-party/$name/"; fi
  done
done
for name in radare2 pwndbg; do
  fetch "$name" "$work/$name.deb"
done
apt-get update
apt-get install -y --no-install-recommends "$work/radare2.deb" "$work/pwndbg.deb"
rm -rf /var/lib/apt/lists/*
fetch pwninit "$work/pwninit"
install -m 0755 "$work/pwninit" /usr/local/bin/pwninit
fetch pwninit-license "$ROOT/third-party/pwninit.LICENSE"
for version in 8 11 21; do
  fetch "java$version" "$work/java$version.tar.gz"
  mkdir -p "$ROOT/jdk-$version"
  tar -xzf "$work/java$version.tar.gz" -C "$ROOT/jdk-$version" --strip-components=1
  printf '#!/bin/sh\nexec /opt/heimdall/jdk-%s/bin/java "$@"\n' "$version" > "/usr/local/bin/java$version"
  chmod 0755 "/usr/local/bin/java$version"
done
for command in java javac jar; do
  ln -s "$ROOT/jdk-21/bin/$command" "/usr/local/bin/$command"
done
fetch ghidra "$work/ghidra.zip"
unzip -q "$work/ghidra.zip" -d "$work/ghidra"
mv "$work"/ghidra/ghidra_* "$ROOT/ghidra"
ln -s "$ROOT/ghidra/support/analyzeHeadless" /usr/local/bin/analyzeHeadless
fetch jadx "$work/jadx.zip"
unzip -q "$work/jadx.zip" -d "$ROOT/vendor/jadx"
chmod +x "$ROOT/vendor/jadx/bin/jadx"
ln -s "$ROOT/vendor/jadx/bin/jadx" /usr/local/bin/jadx
fetch apktool "$ROOT/vendor/apktool.jar"
printf '#!/bin/sh\nexec java -jar /opt/heimdall/vendor/apktool.jar "$@"\n' > /usr/local/bin/apktool
fetch jdumpspider "$ROOT/vendor/JDumpSpider.jar"
fetch jdumpspider-license "$ROOT/third-party/JDumpSpider.LICENSE"
printf '#!/bin/sh\nexec java8 -jar /opt/heimdall/vendor/JDumpSpider.jar "$@"\n' > /usr/local/bin/jdumpspider
fetch rogue-jndi "$work/rogue-jndi.tar.gz"
mkdir "$work/rogue-jndi"
tar -xzf "$work/rogue-jndi.tar.gz" -C "$work/rogue-jndi" --strip-components=1
# Source is pinned and verified; retain its licensing notices with the built jar.
(cd "$work/rogue-jndi" && mvn -B -DskipTests package)
jar=$(find "$work/rogue-jndi/target" -maxdepth 1 -name '*-all.jar' -print -quit)
if [ -z "$jar" ]; then jar=$(find "$work/rogue-jndi/target" -maxdepth 1 -name '*.jar' ! -name 'original-*' -print -quit); fi
test -n "$jar"
install -m 0644 "$jar" "$ROOT/vendor/rogue-jndi.jar"
cp "$work/rogue-jndi/LICENSE" "$ROOT/vendor/rogue-jndi.LICENSE"
printf '#!/bin/sh\nexec java8 -jar /opt/heimdall/vendor/rogue-jndi.jar "$@"\n' > /usr/local/bin/rogue-jndi
fetch nikto "$work/nikto.tar.gz"
mkdir "$ROOT/vendor/nikto"
tar -xzf "$work/nikto.tar.gz" -C "$ROOT/vendor/nikto" --strip-components=1
printf '#!/bin/sh\nexec perl /opt/heimdall/vendor/nikto/program/nikto.pl "$@"\n' > /usr/local/bin/nikto
fetch nuclei-templates "$work/templates.tar.gz"
mkdir "$work/templates"
tar -xzf "$work/templates.tar.gz" -C "$work/templates" --strip-components=1
mkdir -p "$ROOT/nuclei-templates/http"
cp -a "$work/templates/http/cves" "$ROOT/nuclei-templates/http/"
cp "$work/templates/LICENSE.md" "$ROOT/nuclei-templates/LICENSE.md"
# Compatibility for existing playbooks; actual shared files are outside HOME.
ln -s "$ROOT/nuclei-templates" /root/nuclei-templates
for name in one_gadget seccomp-tools; do
  fetch "$name" "$work/$name.gem"
  gem install --no-document "$work/$name.gem"
done
chmod 0755 /usr/local/bin/{apktool,jdumpspider,rogue-jndi,nikto}
rm -rf /root/.m2 /root/.cache /root/.local/share/gem /var/lib/gems/*/cache
