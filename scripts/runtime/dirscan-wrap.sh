#!/usr/bin/env python3
"""dirsearch wrapper: pin bundled paths.txt, tolerate old flags.

dirsearch 0.5.0 dropped --format (now -O / --output-formats). Models still pass
--format=plain and the binary exits 2 before scanning.

Stdout is the unique found paths only (dirsearch progress / errors stay hidden).
Hits also rewrite the -o report so artifacts/dirsearch.txt matches.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_WL = "/opt/heimdall/resources/wordlists/paths.txt"
_URL_RE = re.compile(r"https?://[^\s]+", re.I)


def _default_report() -> Path:
    ws = (os.environ.get("HEIMDALL_WORKSPACE") or "").strip()
    if ws:
        path = Path(ws) / "artifacts" / "dirsearch.txt"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return Path("/tmp/dirsearch.txt")
        return path
    return Path("/tmp/dirsearch.txt")


def rewrite_argv(argv: list[str]) -> tuple[list[str], Path | None, bool]:
    """Map 0.4 flags, inject wordlist/quiet/report. Returns (args, -o path, scan)."""
    out: list[str] = []
    i = 0
    has_o = False
    has_O = False
    has_q = False
    has_v = False
    has_disable = False
    output: Path | None = None
    meta = False
    if argv and argv[0] in {
        "-h",
        "--help",
        "-hh",
        "--help-all",
        "-V",
        "--version",
        "version",
    }:
        meta = True

    while i < len(argv):
        a = argv[i]
        if a in {"--format", "-O", "--output-formats"}:
            val = ""
            if i + 1 < len(argv) and not str(argv[i + 1]).startswith("-"):
                i += 1
                val = argv[i]
            if val:
                out.extend(["-O", val])
                has_O = True
            i += 1
            continue
        if a.startswith("--format="):
            out.extend(["-O", a.split("=", 1)[1]])
            has_O = True
            i += 1
            continue
        if a.startswith("--output-formats="):
            out.append(a)
            has_O = True
            i += 1
            continue
        if a.startswith("--output-file="):
            val = a.split("=", 1)[1]
            out.extend(["-o", val])
            has_o = True
            output = Path(val)
            i += 1
            continue
        if a in {"-o", "--output-file"} or (
            a == "--output"
            or (a.startswith("--output=") and not a.startswith("--output-file"))
        ):
            if "=" in a and a.startswith("--output"):
                val = a.split("=", 1)[1]
            elif i + 1 < len(argv):
                i += 1
                val = argv[i]
            else:
                val = ""
            if val:
                out.extend(["-o", val])
                has_o = True
                output = Path(val)
            i += 1
            continue
        if a in {"-w", "--wordlist", "--wordlists"}:
            # Always pin paths.txt; drop caller -w (dicc / custom lists).
            if i + 1 < len(argv) and not str(argv[i + 1]).startswith("-"):
                i += 2
            else:
                i += 1
            continue
        if a.startswith("-w=") or a.startswith("--wordlist=") or a.startswith("--wordlists="):
            i += 1
            continue
        if a in {"-q", "--quiet-mode"}:
            has_q = True
        if a in {"-v", "--verbose"}:
            has_v = True
        if a == "--disable-cli":
            has_disable = True
        out.append(a)
        i += 1

    scan = not meta
    injected: list[str] = []
    default_wl = os.environ.get("HEIMDALL_DIRSCAN_WORDLIST") or DEFAULT_WL
    if scan and default_wl and Path(default_wl).is_file():
        injected.extend(["-w", default_wl])
    if scan and not has_q and not has_v and not has_disable:
        injected.append("-q")
    if scan and not has_O:
        injected.extend(["-O", "simple"])
        has_O = True
    if scan and not has_o:
        output = _default_report()
        injected.extend(["-o", str(output)])
        has_o = True
    return injected + out, output, scan


def _norm_path(raw: str) -> str | None:
    path = (raw or "").strip()
    if not path:
        return None
    if "://" in path:
        path = urlparse(path).path or ""
    if not path.startswith("/"):
        path = "/" + path
    if path != "/":
        path = path.rstrip("/")
    if path in {"", "/"}:
        return None
    return path


def _paths_from_report(report: Path) -> list[str]:
    try:
        text = report.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for ln in text.splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        urls = _URL_RE.findall(s)
        candidates = urls or ([s] if s.startswith("/") and " " not in s else [])
        for item in candidates:
            path = _norm_path(item)
            if path and path not in seen:
                seen.add(path)
                found.append(path)
    return found


def _emit_found(report: Path | None) -> None:
    if report is None or not report.is_file():
        return
    paths = _paths_from_report(report)
    body = "".join(p + "\n" for p in paths)
    try:
        report.write_text(body, encoding="utf-8")
    except OSError:
        pass
    sys.stdout.write(body)


def main(argv: list[str]) -> int:
    name = Path(argv[0]).name if argv else "dirsearch"
    bindir = os.environ.get("HEIMDALL_DIRSCAN_BINDIR") or "/opt/heimdall/vendor/dirscan/bin"
    real = Path(bindir) / name
    if not os.access(real, os.X_OK):
        sys.stderr.write(f"dirscan-wrap: missing {real}\n")
        return 127
    new, report, scan = rewrite_argv(argv[1:])
    if scan:
        proc = subprocess.run(
            [str(real), *new],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if report is None:
            for i, a in enumerate(new):
                if a in {"-o", "--output-file"} and i + 1 < len(new):
                    report = Path(new[i + 1])
                    break
        _emit_found(report)
    else:
        proc = subprocess.run([str(real), *new], check=False)
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
