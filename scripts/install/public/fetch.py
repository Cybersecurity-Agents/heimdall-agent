#!/usr/bin/python3
"""Fetch a release asset from the committed lock file and verify SHA-256."""
import hashlib
import json
import pathlib
import subprocess
import sys
import shutil
import time

name, dest = sys.argv[1:]
lock = pathlib.Path('/opt/heimdall/resources/toolkits/downloads.lock.json')
asset = json.loads(lock.read_text())['assets'][name]
path = pathlib.Path(dest)
path.parent.mkdir(parents=True, exist_ok=True)
cache = pathlib.Path('/var/cache/heimdall-downloads')
cache.mkdir(parents=True, exist_ok=True)
cached = cache / asset['sha256']
if not cached.exists():
    partial = cached.with_suffix('.partial')
    # Retry with the current partial length, so a slow large download is not
    # restarted from zero. Some source-archive servers do not support ranges.
    for attempt in range(5):
        result = subprocess.run(['curl', '-fsSL', '--continue-at', '-', '--connect-timeout', '30',
                                 '--speed-limit', '1024', '--speed-time', '30', '--max-time', '600',
                                 '-o', str(partial), asset['url']])
        if result.returncode == 0:
            break
        if result.returncode in (22, 33, 36):
            partial.unlink(missing_ok=True)
        if attempt == 4:
            raise SystemExit(f'{name}: download failed after retries (curl {result.returncode})')
        time.sleep(min(2 ** attempt, 10))
    partial.replace(cached)
hash_value = hashlib.sha256()
with cached.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        hash_value.update(chunk)
if hash_value.hexdigest() != asset['sha256']:
    cached.unlink()
    raise SystemExit(f'{name}: SHA-256 mismatch')
shutil.copyfile(cached, path)
print(f'{name}: verified {asset["version"]}')
