# CVE 库

全库是官方 `nuclei-templates` 的 `http/cves`（按年，不精选）。不要 `ls` 整树。

```bash
heimdall-cve                     # 只打印路径
grep -Ril sharepoint /root/nuclei-templates/http/cves /opt/heimdall/cve-poc/nuclei
heimdall-cve CVE-2025-53770
nuclei -duc -u http://TARGET -t <那一条路径>
```

extras 只放官方 HTTP 模板没有的手写条。当前没有 extras。打法见 `workspaces/cve/CLAUDE.md`。
