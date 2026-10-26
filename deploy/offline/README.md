# Docker 离线一键部署

需要 Docker Engine 或 Docker Desktop，以及 Docker Compose v2。镜像为 `linux/amd64`，包含完整工具环境；ARM 主机需要 Docker 的 amd64 模拟支持。

## 从 GitHub Release 一键安装

```bash
curl -fL https://github.com/QiantangCredit/heimdall-agent/releases/latest/download/download-install.sh -o download-install.sh
bash download-install.sh
# 自定义端口：HEIMDALL_PORT=8701 bash download-install.sh
```

下载器自动下载、校验和合并分卷，然后运行包内安装器；已有的 `.env` 和数据卷会保留。安装目录默认为当前路径下的 `heimdall-offline`，可用 `HEIMDALL_INSTALL_DIR` 指定。下载器固定到对应发布版本，也可用 `HEIMDALL_RELEASE` 指定另一个兼容版本。

GitHub 单个附件必须小于 2 GiB，因此约 2.5 GiB 的离线包拆成两个分卷。完全离线安装时，在联网机器从同一 Release 下载 `heimdall-agent-linux-amd64.tar.part01`、`.part02` 和 `SHA256SUMS`，复制到同一目录后执行：

```bash
cat heimdall-agent-linux-amd64.tar.part01 heimdall-agent-linux-amd64.tar.part02 > heimdall-agent-linux-amd64.tar
awk '$2 ~ /^heimdall-agent-linux-amd64\.tar(\.part0[12])?$/ { print }' SHA256SUMS | sha256sum -c -
# macOS 若无 sha256sum，将上一行末尾替换为 shasum -a 256 -c -
tar -xf heimdall-agent-linux-amd64.tar
```

## 启动离线包

解压发布包后运行：

```bash
cd heimdall-agent
bash install.sh
```

安装器校验包内文件、加载镜像并等待操作台健康。默认访问 <http://127.0.0.1:8700>，在「设置 → 模型配置」填写模型地址、API Key 和准确的模型 ID；推理档位、能力协议、上下文与压缩参数均可在该页面修改。

安装前可将 `.env.example` 复制为 `.env`，修改 `HEIMDALL_PORT`（端口被占用时）、模型配置等。安装器保留已有 `.env`。模型参数只在新数据卷首次启动时初始化，后续设置保存在数据卷中。默认 Compose project 为 `heimdall-agent`，数据卷为 `heimdall-agent_heimdall-data`；更改 project 名称会使用另一个数据卷。

此单模型版本保留 Pi Solver / Claude SDK Loop 两种执行入口。API Key 与私有网关没有打入镜像；运行数据不包含在发布包内。需要连接授权实验环境时，可在设置页配置 VPN。请勿使用 `docker compose down -v` 删除已有数据。

从源码构建和打包（打包端需要 Node.js ≥22.19、Python 3 和 Docker）：

```bash
docker build --platform linux/amd64 -f deploy/Dockerfile --target all-in-one -t heimdall-agent:local .
node scripts/build/smoke-container.mjs heimdall-agent:local
npm run package:docker -- heimdall-agent:local deploy/offline/dist/heimdall-agent-linux-amd64.tar
```

外层 `.tar` 已包含 gzip 压缩的镜像。包内 `release.json` 记录镜像 ID、源码 revision 和 lockfile 哈希，`SHA256SUMS` 用于完整性校验。
