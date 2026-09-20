## Intranet dynamic credential dictionary generation

Submit newly observed credential facts in observation_submit.loot as {bucket, value, evidenceRefs}; the host merges them into `.heimdall/traffic/loot.json` and updates the credential dictionaries. Use actual references from observation_context; never write files.

Observer first puts hosts, logins, password shapes, and product names already seen in this window's logs into loot. When the main agent already has read on a web admin, DB, ops panel, or config, but has not dumped the user table / password policy / plaintext config: ANGLES prefer "dump accounts and password rules from the controlled surface". **If `spray_creds.txt` already has a family not yet tried on that surface, do not wait for the dump.**

After a successful login, or when loot / `spray_*.txt` already has logins and password shapes: try **HTTP login, SSH**, and other surfaces by family; keep them `inferred-open`. Passwords and account names in the dictionaries must not contain Chinese Han characters.

Spray when it is warranted (including product install defaults). tried-miss must name **which surface + which family**. New surface or new family stays `inferred-open`. **FORBID must not say spray / no spray / stop spray**; same-family miss is CONFIRMED only.

One miss on generic seeds ≠ "password spray is dead". Blind rockyou / 10k+ public lists do not go in ANGLES.

### loot (observed facts only)

**Submit** this window's observed facts in loot entries; the host deduplicates and preserves existing entries. Record only what already appeared:

- Successful login creds go in `creds` (`user:pass` strings); plaintext from config / desktop / shares goes in `passwords`. Do not stuff a whole `user:pass` string into `passwords` (host will split it if it can, but write the right bucket)
- **Logins** and email-local parts from tables, panels, AD / local hosts. Page display names may go in `names`; logins are account fields or email prefixes only
- Hostnames, product names, dept/org names
- Observed password **rules** in `password_patterns`: login + digits → `{Name}`+that digit family; short prefix + digits → `{Initials}`+that digit family. Do not record only the paired literal
- Products named in the brief, and brands on login/title/install/cert pages → `products` / `org_names`. Long titles may be stored whole. OpenSSH / vsftpd banners are not products. Host also pulls Latin brand tokens from `input.json` description

Once a brand is recorded, the host expands common install-default rules (such as `{Product}@123`) and combines them with accounts; the observer need not wait to see a complete factory-default string. tried-miss must name the family. The host generates `spray_users.txt` / `spray_passwords.txt` / `spray_creds.txt`, **untruncated**. At publication, the host stamps `DICT rev=…` on CONFIRMED and the graph (`spray-dict` node). ANGLES: on untried login surfaces, first use the lightweight general-purpose list `/opt/heimdall/tools/wordlists/passwords.txt`, then targeted spray with `spray_creds.txt` (HTTP / SSH / FTP concurrency 4); no rockyou.

CONFIRMED summary, e.g. `loot: 3 users / 2 passwords / product family → spray_creds.txt`.

Use supported buckets users, names, passwords, hosts, patterns, password_patterns, creds, org_names, products, emails. A credential value is user:password. Display names belong in names; do not invent login aliases.
