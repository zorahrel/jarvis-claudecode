import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectConflict, findGitRoot } from "./lock.js";

/**
 * Phase 2 Plan 02-01 — cwd lock detection (ORC-05).
 *
 * Worktree-aware: two cwds that share an ancestor but live in separate
 * git worktrees (each with its own .git marker file/dir) MUST NOT conflict.
 * Direct subpath overlap inside the same git root MUST conflict.
 */

async function mkRepoRoot(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await fs.mkdir(dir, { recursive: true });
  // .git can be a directory (full checkout) or a file (worktree pointer);
  // we use a directory here — findGitRoot stat()s either case.
  await fs.mkdir(join(dir, ".git"), { recursive: true });
  return dir;
}

test("detectConflict: same cwd → true", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-same-"));
  try {
    const repo = await mkRepoRoot(tmp, "repo");
    assert.equal(await detectConflict(repo, repo), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("detectConflict: subpath inside same git root → true", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-subpath-"));
  try {
    const repo = await mkRepoRoot(tmp, "repo");
    const sub = join(repo, "src", "module");
    await fs.mkdir(sub, { recursive: true });
    assert.equal(await detectConflict(repo, sub), true);
    assert.equal(await detectConflict(sub, repo), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("detectConflict: sibling worktrees (each with .git) → false", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-worktree-"));
  try {
    const worktrees = join(tmp, "worktrees");
    await fs.mkdir(worktrees, { recursive: true });
    // Each worktree is its own git root via its own .git directory.
    const A = await mkRepoRoot(worktrees, "A");
    const B = await mkRepoRoot(worktrees, "B");
    // Direct sibling worktrees do NOT have a startsWith subpath relation,
    // so they don't even reach the worktree-resolution branch — they should
    // be reported as non-conflicting. The assertion here also covers the
    // lock contract: cousins of the same parent are independent.
    assert.equal(await detectConflict(A, B), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("detectConflict: nested under shared parent (no .git separation) → true", async () => {
  // When ONE side is a subpath of the other AND both resolve to the same git
  // root, that's a real conflict (Pitfall 8 says the worktree exception is
  // when each side has its own .git). Here we don't add the inner .git so
  // the nested dir falls under the outer git root.
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-nested-"));
  try {
    const outer = await mkRepoRoot(tmp, "outer");
    const inner = join(outer, "inner");
    await fs.mkdir(inner, { recursive: true });
    assert.equal(await detectConflict(outer, inner), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("detectConflict: realpath canonicalization across symlinks", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-symlink-"));
  try {
    const repo = await mkRepoRoot(tmp, "repo");
    const link = join(tmp, "repo-symlink");
    await fs.symlink(repo, link);
    // Symlink to the same dir resolves to the same realpath → conflict.
    assert.equal(await detectConflict(repo, link), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("findGitRoot: walks up to nearest .git", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-gitroot-"));
  try {
    const repo = await mkRepoRoot(tmp, "repo");
    const deep = join(repo, "a", "b", "c");
    await fs.mkdir(deep, { recursive: true });
    const root = await findGitRoot(deep);
    assert.equal(root, await fs.realpath(repo));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("findGitRoot: returns null when no .git up to filesystem root", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "lock-nogitroot-"));
  try {
    const dir = join(tmp, "nogit");
    await fs.mkdir(dir, { recursive: true });
    // /tmp has no .git so this walk hits the FS root with no marker found.
    // (The macOS / Linux roots don't have a .git either.)
    const root = await findGitRoot(dir);
    assert.equal(root, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
