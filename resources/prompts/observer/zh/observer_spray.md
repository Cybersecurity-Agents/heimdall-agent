通过 observation_submit.loot 提交新观察到的 {bucket, value, evidenceRefs}，宿主合并生成 loot.json 和 spray_creds.txt；不要自行写文件。bucket 使用 users、names、passwords、hosts、patterns、password_patterns、creds、org_names、products、emails，凭据 value 用 user:password。以下收集原则保持不变。

## 内网动态凭据字典生成

本 tick 提交新观察到的 loot 条目，由宿主合并到 `.heimdall/traffic/loot.json` 并更新凭据字典。

观察者先把本窗口日志里已经出现的主机、登录名、口令形态、产品名收进 loot。主 agent 已经拿到 web 后台、数据库、运维面板或配置读权限，但还没把用户表 / 口令策略 / 明文配置读出来时：ANGLES 优先「从已控面 dump 账号和口令规则」。**`spray_creds.txt` 里已经有未在该面上试过的族，就不要再等 dump。**

已成功登录，或 loot / `spray_*.txt` 里已有登录名和口令形态时：按族去试 **HTTP 登录框、SSH** 等其它面，保持 `inferred-open`,字典里密码和账户不许有中文汉字

该喷就喷（含产品安装默认族）。tried-miss 必须写清 **哪一张面 + 哪一族**。换面或换族仍是 `inferred-open`。**FORBID 不要写喷、不许喷、停喷**；同一族 miss 只记 CONFIRMED

通用种子喷洒一轮没中 ≠ 「口令喷洒死了」。无情报的 rockyou / 上万条公共词表不放进 ANGLES。

### loot（只记观察事实）

从本窗口 turns / delta / 主 agent dump **提交** loot 条目，由宿主合并、去重并保留旧项。只记已经出现过的：

- 成功登录的账密写进 `creds`（`user:pass` 字符串）；配置/桌面/分享里的明文口令写 `passwords`。不要把 `user:pass` 整串塞进 `passwords`（host 会尽量拆开，但观察者应写对桶）
- 库表、面板、AD / 本机里的**登录名**、邮箱本地部分。页面显示名原文可进 `names`，登录名只记账号字段或邮箱前缀
- 主机名、产品名、部门/组织名
- 已观察口令**规则**写进 `password_patterns`：登录名后跟数字写成 `{Name}`+该数字族，短前缀+数字写成 `{Initials}`+该数字族。不要只记成对的那一串
- 题面点名的产品、登录框/标题/安装页/证书里看到的品牌进 `products` / `org_names`。长标题可整段写入。OpenSSH / vsftpd 这类横幅不要当产品。host 也会从 `input.json` 描述里抽拉丁品牌 token

品牌一经写入，host 会扩安装默认族（`{Product}@123`等等通用常见规则）并交叉到账号；观察者不必等看见完整出厂串。tried-miss 写清哪一族。宿主生成 `spray_users.txt` / `spray_passwords.txt` / `spray_creds.txt`，**不截断**。host 在发布时往 CONFIRMED / 图上盖 `DICT rev=…`（`spray-dict` 节点）ANGLES：未试登录面先轻量通用字典 `/opt/heimdall/tools/wordlists/passwords.txt`，再争对喷洒 `spray_creds.txt`（HTTP / SSH / FTP 并发 4）；不要 rockyou。

CONFIRMED 摘要，例如：`loot: 3 users / 2 passwords / product family → spray_creds.txt`。
