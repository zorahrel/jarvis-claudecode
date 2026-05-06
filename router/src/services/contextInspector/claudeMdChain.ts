import { promises as fs } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, resolve, join } from "path";

/**
 * Recursive resolver for Claude Code's `@<path>` import syntax in CLAUDE.md files.
 *
 * Algorithm:
 * - Read the FIRST 4 KB of each file (matches Claude Code preset behavior — only
 *   the directives section near the top is scanned for @-imports).
 * - Match `^@(\S+)` (multiline, line-anchored, captures the path token).
 * - Expand the captured ref:
 *     - `~/...` or `~`        → resolve relative to homedir()
 *     - absolute (`/abs/...`) → use verbatim
 *     - relative              → resolve against the importing file's directory
 * - Visit each absolute path at most once (cycle detection).
 * - Missing files are silently recorded in `missing[]` (never throw).
 * - Tokens estimate: `Math.ceil(bytes / 4)` per RESEARCH.md proxy.
 *
 * Returns DFS-from-root entry order. Root entry first, then its imports in
 * appearance order, recursing depth-first into each.
 *
 * Used by Plan 03 Task 2 (`breakdown.ts`) to compute the `claudemd_chain`
 * category of the 8-way breakdown.
 */

const HEAD_BYTES = 4096;
const IMPORT_REGEX = /^@(\S+)/gm;

export interface ChainEntry {
  path: string;
  bytes: number;
  tokens: number;
  isRoot: boolean;
}

export interface ChainResult {
  entries: ChainEntry[];
  totalBytes: number;
  totalTokens: number;
  missing: string[];
}

/** Expand `~/...` to `$HOME/...`; pass through abs paths; resolve relative against `fromDir`. */
function expandRef(ref: string, fromDir: string): string {
  if (ref === "~" || ref.startsWith("~/")) {
    return ref === "~" ? homedir() : join(homedir(), ref.slice(2));
  }
  if (isAbsolute(ref)) return ref;
  return resolve(fromDir, ref);
}

/** Read leading bytes of a file. Returns the buffer + total file size. */
async function readHead(path: string, maxBytes: number): Promise<{ head: string; size: number } | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(path, "r");
    const st = await fh.stat();
    const toRead = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, 0);
    return { head: buf.toString("utf8"), size: st.size };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

/** Extract @-import refs from a head buffer using a multiline-anchored regex. */
function extractRefs(head: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_REGEX.lastIndex = 0;
  while ((m = IMPORT_REGEX.exec(head)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

export async function expandClaudeMdChain(rootPath: string): Promise<ChainResult> {
  const visited = new Set<string>();
  const entries: ChainEntry[] = [];
  const missing: string[] = [];

  async function visit(path: string, isRoot: boolean): Promise<void> {
    const abs = resolve(path);
    if (visited.has(abs)) return;
    visited.add(abs);

    const result = await readHead(abs, HEAD_BYTES);
    if (!result) {
      missing.push(abs);
      return;
    }

    const { head, size } = result;
    entries.push({
      path: abs,
      bytes: size,
      tokens: Math.ceil(size / 4),
      isRoot,
    });

    const refs = extractRefs(head);
    const fromDir = dirname(abs);
    for (const ref of refs) {
      const target = expandRef(ref, fromDir);
      await visit(target, false);
    }
  }

  await visit(rootPath, true);

  let totalBytes = 0;
  for (const e of entries) totalBytes += e.bytes;

  return {
    entries,
    totalBytes,
    totalTokens: Math.ceil(totalBytes / 4),
    missing,
  };
}
