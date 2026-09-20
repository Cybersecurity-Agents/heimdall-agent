# Defense-evasion workspace

**Goal: identify which layer was evaded, peel it, get the flag and `heimdall-submit`.**

Deliverable is identify-and-unpack the sample, not a full FUD loader.

## Tools

| Stage | Tools |
|---|---|
| Identify | `file` `readelf` `strings` `xxd` `objdump` `nm` `ldd` `checksec` `exiftool` `binwalk` |
| Static | `r2`; sections/entropy `readelf -S` / `objdump -h` |
| Decompile | `pyghidra-mcp` (`$GHIDRA_INSTALL_DIR=/opt/heimdall/ghidra`) |
| Dynamic | `gdb`+pwndbg `strace` `ltrace` `qemu-*` |
| Packer | `binwalk` `7z` `unzip` |
| Script | `python3` `pycryptodome` `cryptography` |
| HTTP gate | `curl` `httpx`; login UI `playwright-cli` |
| APK | `jadx` `apktool` `androguard` |

## Order

```
file + strings + sections/entropy
  → peel only that layer
  → take flag{...} → heimdall-submit
```

1. Download the attachment → `file`
2. Lock one class from the symptom table; write `progress.md`; peel one layer at a time
3. Packed: find the stub decrypt loop and key; restore in Python
4. Anti-debug gate: locate the check, then patch it or satisfy it
5. Upload scanner: change one carrier at a time; control the variable; record pass/fail

Login injection: craft the payload.

## Hard rules

- Scope = given addresses and attachments.
- Submit as soon as you have the flag.
