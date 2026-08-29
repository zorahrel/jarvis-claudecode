#!/usr/bin/env python3
"""Prune ~/.jcode/scratch entries older than N days (default 7).

Scratch is jcode's disposable working area. Anything not touched in a week is
throwaway test fixtures. Usage: prune_scratch.py [days] [--dry-run]
"""
import os
import shutil
import sys
import time

SCRATCH = os.path.expanduser("~/.jcode/scratch")
days = 7
dry = "--dry-run" in sys.argv
for a in sys.argv[1:]:
    if a.isdigit():
        days = int(a)

cutoff = time.time() - days * 86400
freed = 0
count = 0
for name in os.listdir(SCRATCH):
    p = os.path.join(SCRATCH, name)
    try:
        if os.lstat(p).st_mtime >= cutoff:
            continue
    except OSError:
        continue
    size = 0
    if os.path.isdir(p) and not os.path.islink(p):
        for root, _dirs, files in os.walk(p, onerror=lambda e: None):
            for f in files:
                try:
                    size += os.lstat(os.path.join(root, f)).st_size
                except OSError:
                    pass
    else:
        try:
            size = os.lstat(p).st_size
        except OSError:
            pass
    freed += size
    count += 1
    if not dry:
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                os.remove(p)
            except OSError:
                pass

print(f"{'would remove' if dry else 'removed'}: {count} entries, {freed/1e9:.2f} GB")
