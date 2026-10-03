#!/usr/bin/env python3
"""Prune top-level entries of a throwaway directory that nobody touched in N days.

Usage: prune_stale.py <dir> [days=3] [--dry-run]

Unlike prune_scratch.py, an entry counts as stale only if its NEWEST file is
older than the cutoff: a directory's own mtime does not change when files
deep inside are rewritten, so a cache in active use (tsx-501,
node-compile-cache) would otherwise look abandoned.
Written for ~/.openclaw/tmp, which grew to 24 GB of model-catalog,
update-canary and plugin-build dirs that OpenClaw never deletes.
"""
import os
import shutil
import sys
import time

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if not args:
    sys.exit("usage: prune_stale.py <dir> [days] [--dry-run]")
root = os.path.expanduser(args[0])
days = int(args[1]) if len(args) > 1 else 3
dry = "--dry-run" in sys.argv
cutoff = time.time() - days * 86400


def newest_and_size(p):
    st = os.lstat(p)
    newest, size = st.st_mtime, st.st_size
    if os.path.isdir(p) and not os.path.islink(p):
        for r, ds, fs in os.walk(p, onerror=lambda e: None):
            for x in ds + fs:
                try:
                    s = os.lstat(os.path.join(r, x))
                except OSError:
                    continue
                newest = max(newest, s.st_mtime)
                size += s.st_size
    return newest, size


count = freed = kept = 0
for name in os.listdir(root) if os.path.isdir(root) else []:
    p = os.path.join(root, name)
    try:
        newest, size = newest_and_size(p)
    except OSError:
        continue
    if newest >= cutoff:
        kept += 1
        continue
    count += 1
    freed += size
    if dry:
        continue
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p, ignore_errors=True)
    else:
        try:
            os.remove(p)
        except OSError:
            pass

verb = "would remove" if dry else "removed"
print(f"{verb}: {count} entries, {freed/1e9:.2f} GB ({kept} recent kept) in {root}")
