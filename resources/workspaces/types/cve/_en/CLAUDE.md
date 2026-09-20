# CVE / generic vuln

**Goal: identify the product → replay the yaml → get `flag{...}` → `heimdall-submit`.**

Do not scan the network. Only the given ports. No outbound. No Collaborator / interactsh.

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

Libraries: `/root/nuclei-templates/http/cves` (official full tree) + extras `/opt/heimdall/cve-poc/nuclei`. `grep -l` filenames only. Do not `ls` year directories / use `-tags` / scan the full library with nuclei. Many yaml files embed Interactsh / JS helpers; split them into curl requests first, then use a single nuclei template if that is not feasible.

## WAF

Blocked = the gate caught a literal feature, **not that the bug is gone**. Leave the payload unchanged and change one carrier at a time.

Log4j / JNDI: listen inside the lab with `rogue-jndi` + `java8`, no outbound OAST.

## Tools

| Surface | Tools |
|---|---|
| Fingerprint | `curl -si` `httpx` `whatweb`; multi-port `nmap -sV` |
| Library | bash `grep -Ril`; `heimdall-cve CVE-…` |
| Replay | `curl` / `python3`; single `nuclei -duc -t` |
| Login UI | `playwright-cli` |
| Java | `rogue-jndi` `ldaps-wrap` `jdumpspider` (`java8`) |
| Injection | `sqlmap` |
