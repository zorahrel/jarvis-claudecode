import { promises as fs } from "fs";
import { dirname, sep } from "path";

/**
 * Cwd lock detection — Phase 2 Plan 02-01 (ORC-05).
 *
 * Two Claude Code sessions targeting the same repo (or nested paths inside
 * the same repo) MUST NOT both be approved for inject simultaneously — they
 * would clobber each other's edits. Two sibling worktrees of the same repo
 * (e.g. `~/.omnara/worktrees/A` and `~/.omnara/worktrees/B`) live under a
 * shared parent but are independent git roots, so they DO NOT conflict.
 *
 * Decision rules:
 *  - Identical realpath → conflict.
 *  - One realpath is a strict subpath of the other:
 *      * same git root (or no git roots resolved) → conflict.
 *      * different git roots → independent worktrees → no conflict.
 *  - Otherwise (siblings or unrelated paths) → no conflict.
 *
 * `findGitRoot` walks up from the canonicalized cwd looking for a `.git`
 * entry (file marker for worktree, or directory for primary checkout).
 * Returns null if none is found before hitting the filesystem root.
 */

export async function findGitRoot(p: string): Promise<string | null> {
  let cur: string;
  try {
    cur = await fs.realpath(p);
  } catch {
    return null;
  }
  while (cur !== "/" && cur !== "") {
    try {
      await fs.stat(`${cur}/.git`);
      return cur;
    } catch {
      /* keep walking */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export async function detectConflict(a: string, b: string): Promise<boolean> {
  let ra: string, rb: string;
  try {
    [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  } catch {
    return false;
  }
  if (ra === rb) return true;
  if (ra.startsWith(rb + sep) || rb.startsWith(ra + sep)) {
    // Subpath overlap — confirm same git root. Sibling worktrees of the same
    // repo (each with its own .git) MUST be independent.
    const [ga, gb] = await Promise.all([findGitRoot(ra), findGitRoot(rb)]);
    if (ga && gb && ga !== gb) return false;
    return true;
  }
  return false;
}
