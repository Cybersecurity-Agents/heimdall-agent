# Web workspace
**Goal: get the flag and `heimdall-submit`.**
## Tools

| Surface | Tools |
|---|---|
| Platform | `heimdall-challenge` `heimdall-submit` `heimdall-ocr` `heimdall-cve` |
| HTTP | `playwright-cli` (session `.heimdall/browser/state.json`) `curl` `httpx` `jq` |
| Scan/inject | `sqlmap`; `dirsearch` + `paths.txt` (language `-e php`)
| Images | `heimdall-ocr` `tesseract` `convert` (default `eng+chi_sim`) |
| Java | `jdumpspider` `rogue-jndi` `ldaps-wrap`; `java8` / `java11` |

`cmd --help`. Webshell / intranet tunnels → intranet workspace.

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

## Hard rules

- Scope = `container_addr` / `input.json` addresses.
- On `flag{...}`, submit or write `flags.json`; multi-flag until `is_completed`. Submit details are in the system prompt.
