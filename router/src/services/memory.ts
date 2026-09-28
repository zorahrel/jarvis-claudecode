/**
 * Memory service: bridge al docs-index su :3342 (router/scripts/docs-server.py),
 * che indicizza i file Markdown di ~/.claude/jarvis/memory/. Tutto on-device.
 *
 * OMEGA (:3343, memoria conversazionale) è stato dismesso il 28/09/2026: le sue
 * memorie sono file in memory/projects/, quindi le trova questa stessa ricerca.
 */

const DOCS_URL = "http://localhost:3342";

export interface DocResult {
  id: string;
  text: string;
  score: number;
  metadata: {
    file: string;
    path: string;
    scope: string;
    size: number;
    first_line: string;
  };
}

async function fetchJson(url: string, opts?: RequestInit, timeoutMs = 10000): Promise<any> {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch with explicit timeout/error signal for callers that need to surface it */
async function fetchJsonTimed<T = any>(url: string, opts?: RequestInit, timeoutMs = 10000): Promise<{ data: T | null; timedOut: boolean }> {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    return { data: (await res.json()) as T, timedOut: false };
  } catch (e: any) {
    const name = e?.name || "";
    return { data: null, timedOut: name === "TimeoutError" || name === "AbortError" };
  }
}

/** Search the docs-index; timedOut lets the caller surface a "partial" state */
export async function searchDocsDetailed(query: string, scope?: string, limit = 5): Promise<{ results: DocResult[]; timedOut: boolean }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (scope) params.set("scope", scope);
  const { data, timedOut } = await fetchJsonTimed<{ results: DocResult[] }>(`${DOCS_URL}/search?${params}`);
  return { results: data?.results ?? [], timedOut };
}

/** Docs-index stats (files, chunks, per-scope counts) */
export async function getMemoryStats(): Promise<{ docs: any }> {
  return { docs: await fetchJson(`${DOCS_URL}/stats`) };
}

/** Indexed documents, optionally filtered by scope */
export async function getDocuments(scope?: string): Promise<any[]> {
  const params = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const data = await fetchJson(`${DOCS_URL}/documents${params}`);
  return data?.documents ?? [];
}

/** Trigger a reindex — longer timeout because a full pass over 200+ files takes 10-30s */
export async function reindexDocs(): Promise<any> {
  return await fetchJson(`${DOCS_URL}/reindex`, { method: "POST" }, 90000);
}
