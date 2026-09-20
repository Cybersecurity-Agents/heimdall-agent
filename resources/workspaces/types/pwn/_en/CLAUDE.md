# Pwn / binary workspace

**Goal: get the flag and `heimdall-submit`.**

Tools are already in the image; call them directly.

## Tools

| Stage | Tools |
|---|---|
| Identify | `file` `readelf` `strings` `xxd` `objdump` `nm` `ldd` `checksec` `patchelf` |
| Static | `r2` / `radare2` |
| Decompile | `pyghidra-mcp` (`$GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra`) |
| Dynamic | `gdb`+pwndbg `gdb-multiarch` `gdbserver` `strace` `ltrace` `qemu-*` |
| ROP / libc | `ROPgadget` `one_gadget` `seccomp-tools` `pwninit` |
| Write exp | `pwntools` `angr` `unicorn` `capstone` `keystone` `elftools` `z3` |
| Build | `gcc` `g++` `make` `cmake` `nasm` |
| APK | `jadx` `apktool` `androguard` |

Default `java`=21 (Ghidra). `java8` / `java11` are for heapdump / rogue-jndi.
