#!/usr/bin/env python3
"""Remove abandoned Chrome temp profiles (dr-*) from $TMPDIR.

A profile is kept when some live process still lists it as --user-data-dir.
Paths are normalised through realpath, because /var/folders and
/private/var/folders are the same place and getconf hands back a trailing slash.
Usage: prune_chrome_temp.py [--dry-run]
"""
import os
import re
import shutil
import subprocess
import sys

dry = "--dry-run" in sys.argv
tmp = os.path.realpath(subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"],
                                      capture_output=True, text=True).stdout.strip())

ps = subprocess.run(["ps", "-eo", "command"], capture_output=True, text=True).stdout
live = set()
for m in re.finditer(r"--user-data-dir=(\S+)", ps):
    p = m.group(1)
    if os.path.exists(p):
        live.add(os.path.realpath(p))

freed = 0
count = 0
for name in os.listdir(tmp):
    if not name.startswith("dr-"):
        continue
    p = os.path.realpath(os.path.join(tmp, name))
    if p in live or not os.path.isdir(p):
        continue
    size = 0
    for root, _dirs, files in os.walk(p, onerror=lambda e: None):
        for f in files:
            try:
                size += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    freed += size
    count += 1
    if not dry:
        shutil.rmtree(p, ignore_errors=True)

print(f"{'would remove' if dry else 'removed'}: {count} profiles, "
      f"{freed/1e9:.2f} GB ({len(live)} live profiles kept)")
