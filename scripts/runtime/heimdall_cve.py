#!/usr/bin/env python3
"""Point at the CVE yaml trees. CVE ids resolve by filename; products are grep."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

_CVE_QUERY_RE = re.compile(r"^cve-\d{4}-\d+$", re.I)
_HEAD_LINES = 16


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def extras_nuclei() -> Path | None:
    raw = (os.environ.get("HEIMDALL_CVE_POC") or "").strip()
    here = Path(__file__).resolve()
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw))
    candidates.extend(
        [
            Path("/opt/heimdall/cve-poc"),
            Path(__file__).resolve().parents[2] / "resources" / "cve",
            here.parents[1] / "deploy" / "inimage" / "cve-poc",
        ]
    )
    seen: set[Path] = set()
    for raw_path in candidates:
        try:
            path = raw_path.resolve()
        except OSError:
            continue
        if path in seen:
            continue
        seen.add(path)
        nuclei = path / "nuclei" if _is_dir(path / "nuclei") else path
        if _is_dir(nuclei) and any(nuclei.glob("*.y*ml")):
            return nuclei
    return None


def cves_dir() -> Path | None:
    raw = (
        os.environ.get("HEIMDALL_NUCLEI_TEMPLATES")
        or os.environ.get("NUCLEI_TEMPLATES")
        or ""
    ).strip()
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw))
    candidates.extend(
        [
            Path("/root/nuclei-templates"),
            Path("/opt/nuclei-templates"),
            Path.home() / "nuclei-templates",
        ]
    )
    seen: set[Path] = set()
    for cand in candidates:
        try:
            path = cand.resolve()
        except OSError:
            continue
        if path in seen:
            continue
        seen.add(path)
        http_cves = path / "http" / "cves"
        if _is_dir(http_cves):
            return http_cves
    return None


def lib_dirs() -> list[Path]:
    out: list[Path] = []
    seen: set[Path] = set()
    for path in (cves_dir(), extras_nuclei()):
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out


def find_cve(cve: str, roots: list[Path] | None = None) -> list[Path]:
    want = (cve or "").strip().lower()
    if not _CVE_QUERY_RE.match(want):
        return []
    hits: list[Path] = []
    for root in roots if roots is not None else lib_dirs():
        try:
            files = list(root.rglob("*.yaml")) + list(root.rglob("*.yml"))
        except OSError:
            continue
        for path in files:
            if want in path.name.lower():
                hits.append(path)
    hits.sort(key=lambda p: p.name)
    return hits


def _read_head(path: Path, n: int = _HEAD_LINES) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[:n]
    except OSError:
        return []


def _grep_line(roots: list[Path], needle: str = "sharepoint") -> str:
    quoted = " ".join(str(p) for p in roots) or "/root/nuclei-templates/http/cves"
    return f"grep -Ril {needle} {quoted}"


def _print_usage(roots: list[Path]) -> None:
    if roots:
        print("# CVE yaml")
        for path in roots:
            print(path)
    else:
        print("# no CVE yaml trees", file=sys.stderr)
    print("grep -Ril <产品字样> <上面的目录>")
    print("heimdall-cve CVE-2025-53770")
    print(f"# 例: {_grep_line(roots)}")
    print("# 不要 ls 全库；nuclei -duc -t <路径> 只打这一条")


def _print_detail(path: Path) -> None:
    print(path)
    print("  ---")
    for line in _read_head(path):
        print(f"  {line}")
    print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Resolve a CVE id to yaml. Product names: grep the printed dirs."
    )
    parser.add_argument("query", nargs="?", default="", help="CVE-YYYY-NNNNN")
    args = parser.parse_args(argv)
    roots = lib_dirs()
    q = (args.query or "").strip()
    if not q:
        if not roots:
            print("no CVE library (expected /root/nuclei-templates/http/cves)", file=sys.stderr)
            return 1
        _print_usage(roots)
        return 0
    if not _CVE_QUERY_RE.match(q):
        print(_grep_line(roots, q))
        print("# 产品名用 bash 跑上面这行；Grep 工具只扫工作区，扫不到库")
        return 0
    hits = find_cve(q, roots)
    if not hits:
        print(f"not found: {q}", file=sys.stderr)
        for path in roots:
            print(f"# {path}", file=sys.stderr)
        return 1
    print(f"# {len(hits)}  {q}")
    for path in hits:
        _print_detail(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
