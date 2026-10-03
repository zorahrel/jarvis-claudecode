#!/usr/bin/env python3
"""Prune Claude Code session temp dirs in /private/tmp/claude-501 that are dead.

Usage: prune_claude_tmp.py [hours=24] [--dry-run]

A session dir (<project>/<session-id>) goes only if no running process mentions
its session id AND its newest file is older than the cutoff. Live sessions are
never touched, however big: on 03/10/2026 one live armonia-site session held
37 GB of scratchpad, and that is its owner's call, not ours.
"""
import os
import shutil
import subprocess
import sys
import time

ROOT = "/private/tmp/claude-501"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
hours = float(args[0]) if args else 24
dry = "--dry-run" in sys.argv
cutoff = time.time() - hours * 3600
ps = subprocess.run(["ps", "-Ao", "command="], capture_output=True, text=True).stdout

count = freed = live_kept = 0
for proj in os.listdir(ROOT) if os.path.isdir(ROOT) else []:
    pp = os.path.join(ROOT, proj)
    if not os.path.isdir(pp) or proj == "bash-edit-diff":
        continue
    for sid in os.listdir(pp):
        sp = os.path.join(pp, sid)
        if not os.path.isdir(sp):
            continue
        if sid in ps:
            live_kept += 1
            continue
        size, newest = 0, os.lstat(sp).st_mtime
        for r, ds, fs in os.walk(sp, onerror=lambda e: None):
            for f in fs:
                try:
                    s = os.lstat(os.path.join(r, f))
                except OSError:
                    continue
                size += s.st_size
                newest = max(newest, s.st_mtime)
        if newest >= cutoff:
            continue
        count += 1
        freed += size
        if not dry:
            shutil.rmtree(sp, ignore_errors=True)

verb = "would remove" if dry else "removed"
print(f"{verb}: {count} dead sessions, {freed/1e9:.2f} GB ({live_kept} live kept)")
