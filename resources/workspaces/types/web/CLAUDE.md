# Web 应用工作区
**目标：拿到 flag 并 `heimdall-submit`。**
## 工具

| 面 | 工具 |
|---|---|
| 平台 | `heimdall-challenge` `heimdall-submit` `heimdall-ocr` `heimdall-cve` |
| HTTP | `playwright-cli`（会话 `.heimdall/browser/state.json`）`curl` `httpx` `jq` |
| 扫/注 | `sqlmap`；`dirsearch` + `paths.txt`（换语言 `-e php`）
| 图 | `heimdall-ocr` `tesseract` `convert`（默认 `eng+chi_sim`） |
| Java | `jdumpspider` `rogue-jndi` `ldaps-wrap`；`java8` / `java11` |

`cmd --help`。webshell / 内网隧道 → 内网工作区。

内置精选字典位于 `/opt/heimdall/tools/wordlists/`（详见 `README.md`），按漏洞类型选用：路径/泄露 `paths.txt`，弱口令 `usernames.txt` + `passwords.txt`，文件读取/穿越 `lfi.txt`，SQL 注入 `sqli.txt`。

## 执行

读简报 → 顺着题目线索链接、表单、JS、报错、暴露文件 → `playwright-cli` 登录 / 长会话 / XSS → 拿到 `flag{...}` 就交。

按症状锁一类再证，写进 `progress.md`。像已知产品 → bash `grep -Ril <产品> /root/nuclei-templates/http/cves` → `heimdall-cve CVE-…`。


范围 = `input.json` 给定地址，不要扫描网络，web只有给定的端口，静态/API 用 `curl`/`httpx`；登录与 XSS 用 `playwright-cli`。临时文件放 `tmp/`。无出网：听本机 IP，不要 Collaborator。

## Playwright

镜像已带 Chromium。开一次会话，登录后 `state-save` / `state-load`。

```bash
playwright-cli open http://TARGET/
playwright-cli snapshot
playwright-cli click e3
playwright-cli fill e5 'user'
playwright-cli eval '() => document.cookie'
playwright-cli state-save .heimdall/browser/state.json
playwright-cli cookie-list
```

XSS：这个浏览器就是受害者；用 `eval` / `console` / `cookie-list` 取赃。

## OCR（验证码 / canvas / 图中 flag）

DOM 读不到的字打到 stdout：

```bash
heimdall-ocr tmp/c.png
# 短验证码
convert tmp/c.png -colorspace Gray -resize 300% -threshold 50% tmp/c2.png
tesseract tmp/c2.png stdout -l eng --psm 7
```
提交前去掉 OCR 插入的空白。短码用 `--psm 7`（`--psm 8`+白名单易把 `A7K2` 认成 `ATK2`）。

## 硬规则

- 范围 = `container_addr` / `input.json` 地址。
- 拿到 `flag{...}` 就交或写入 `flags.json`；多 flag 打到 `is_completed`。提交细节见系统提示。
