# Pwn / 二进制工作区

**目标：拿到 flag 并 `heimdall-submit`。**

工具已在镜像里，直接调用。

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

默认 `java`=21（Ghidra）。`java8` / `java11` 给 heapdump / rogue-jndi。
