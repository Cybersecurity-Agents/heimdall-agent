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
  → 只拆这一层
  → 取 flag{...} → heimdall-submit
```

1. 下载附件 → `file`
2. 症状表锁一类，写进 `progress.md`；一次拆一层
3. 加壳：找 stub 解密循环与密钥，Python 还原
4. 反调试门：定位检查后补掉或满足它
5. 上传扫描器：一次改一种载体，控制变量对照过/不过

登录注入手写 payload。

## 硬规则

- 范围 = 给定地址与附件。
- 拿到 flag 就交。。
