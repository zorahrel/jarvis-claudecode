import { promises as fs } from "fs";
import { join } from "path";
import { sumTokens, countTurns, countCompactions } from "./jsonlParser.js";

/**
 * Disk hygiene + recent-sessions enrichment for the Disco footer + "Storico
 * recente" UI section (CTX-11 + CTX-12).
 *
 * - `diskStats(projectsRoot)` → totals across all `~/.claude/projects/<slug>/*.jsonl`
 *   for the footer line: "Disco: ZZZ MB · NNNN JSONL · ⚠ K file >30g"
 * - `recentSessions(projectsRoot, limit)` → newest-first sessions enriched with
 *   tokens/turns/compactions (per-file via jsonlParser).
 *
 * Read-only — no cleanup actions in v1 (cleanup is M6 deferred).
 */

const THIRTY_DAYS_MS = 30 * 86400 * 1000;

export interface DiskStats {
  totalMb: number;
  totalJsonl: number;
  filesOlderThan30d: number;
}

export interface RecentSession {
  slug: string;
  sessionId: string;
  transcriptPath: string;
  /** Best-effort cwd reconstruction from slug. NOT guaranteed invertible (see session-discovery report). */
  cwd: string;
  /** Route name extracted from `agents/<NAME>` in cwd, or null. */
  routeHint: string | null;
  /** Last modification time, ms epoch. */
  mtime: number;
  /** File size in bytes. */
  sizeBytes: number;
  totalTokens: number;
  turnCount: number;
  compactionCount: number;
}

interface JsonlFileRef {
  slug: string;
  sessionId: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Enumerate all .jsonl files across all slug directories under projectsRoot. */
async function enumerateJsonlFiles(projectsRoot: string): Promise<JsonlFileRef[]> {
  const out: JsonlFileRef[] = [];
  let slugDirs: import("fs").Dirent[];
  try {
    slugDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const slugDirent of slugDirs) {
    if (!slugDirent.isDirectory()) continue;
    const slug = slugDirent.name;
    const slugDir = join(projectsRoot, slug);
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const fullPath = join(slugDir, e.name);
      try {
        const st = await fs.stat(fullPath);
        out.push({
          slug,
          sessionId: e.name.replace(/\.jsonl$/, ""),
          path: fullPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  return out;
}

export async function diskStats(projectsRoot: string): Promise<DiskStats> {
  const files = await enumerateJsonlFiles(projectsRoot);
  let totalBytes = 0;
  let filesOlderThan30d = 0;
  const now = Date.now();
  for (const f of files) {
    totalBytes += f.size;
    if (now - f.mtimeMs > THIRTY_DAYS_MS) filesOlderThan30d++;
  }
  return {
    totalMb: totalBytes / 1024 / 1024,
    totalJsonl: files.length,
    filesOlderThan30d,
  };
}

/**
 * Reconstruct a cwd from a slug. The encoding (path.replace(/\//g, '-') with a
 * leading dash) is NOT cleanly invertible — paths containing literal dashes
 * collapse. This is best-effort for display only.
 */
function slugToCwd(slug: string): string {
  return "/" + slug.replace(/^-/, "").replace(/-/g, "/");
}

/** Try to extract a route hint from a reconstructed cwd. */
function extractRouteHint(cwd: string): string | null {
  // Match ".../jarvis/agents/<NAME>" optionally followed by /something
  const m = cwd.match(/\/jarvis\/agents\/([^/]+)/);
  return m ? m[1] : null;
}

export async function recentSessions(
  projectsRoot: string,
  limit: number = 10,
): Promise<RecentSession[]> {
  const files = await enumerateJsonlFiles(projectsRoot);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = files.slice(0, limit);

  const enriched = await Promise.all(
    top.map(async (f): Promise<RecentSession> => {
      const cwd = slugToCwd(f.slug);
      const [tokens, turns, compactions] = await Promise.all([
        sumTokens(f.path),
        countTurns(f.path),
        countCompactions(f.path),
      ]);
      return {
        slug: f.slug,
        sessionId: f.sessionId,
        transcriptPath: f.path,
        cwd,
        routeHint: extractRouteHint(cwd),
        mtime: f.mtimeMs,
        sizeBytes: f.size,
        totalTokens: tokens.total,
        turnCount: turns,
        compactionCount: compactions,
      };
    }),
  );

  return enriched;
}
