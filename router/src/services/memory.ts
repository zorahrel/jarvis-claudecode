/**
 * Memory service - bridges to the two local Python HTTP servers:
 *   - ChromaDB on :3342 — document memory over memory/*.md
 *   - OMEGA    on :3343 — conversation memory (SQLite + sqlite-vec + ONNX)
 *
 * Both run entirely on-device. No external APIs.
 */

const CHROMA_URL = "http://localhost:3342";
const MEMORY_URL = process.env.MEMORY_URL || "http://localhost:3343";

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

export interface MemoryResult {
  id: string;
  memory: string;
  score?: number;
  user_id?: string;
  created_at?: string;
  metadata?: Record<string, any>;
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

/** Search ChromaDB documents */
export async function searchDocs(query: string, scope?: string, limit = 5): Promise<DocResult[]> {
  const r = await searchDocsDetailed(query, scope, limit);
  return r.results;
}

/** Search ChromaDB with timeout signal — caller can surface "partial" state */
export async function searchDocsDetailed(query: string, scope?: string, limit = 5): Promise<{ results: DocResult[]; timedOut: boolean }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (scope) params.set("scope", scope);
  const { data, timedOut } = await fetchJsonTimed<{ results: DocResult[] }>(`${CHROMA_URL}/search?${params}`);
  return { results: data?.results ?? [], timedOut };
}

/** Search memories */
export async function searchMemories(query: string, userId = "business", limit = 5): Promise<MemoryResult[]> {
  const r = await searchMemoriesDetailed(query, userId, limit);
  return r.results;
}

/** Search with timeout signal */
export async function searchMemoriesDetailed(query: string, userId = "business", limit = 5): Promise<{ results: MemoryResult[]; timedOut: boolean }> {
  const params = new URLSearchParams({ q: query, user_id: userId, limit: String(limit) });
  const { data, timedOut } = await fetchJsonTimed<{ results: MemoryResult[] }>(`${MEMORY_URL}/search?${params}`);
  return { results: data?.results ?? [], timedOut };
}

/** Add a memory */
export async function addMemory(text: string, userId = "business", metadata?: Record<string, string>): Promise<void> {
  await fetchJson(`${MEMORY_URL}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, user_id: userId, metadata }),
  });
}

/** Get combined stats from both services */
export async function getMemoryStats(): Promise<{ docs: any; memories: any }> {
  const [docs, memories] = await Promise.all([
    fetchJson(`${CHROMA_URL}/stats`),
    fetchJson(`${MEMORY_URL}/stats`),
  ]);
  return { docs, memories };
}

/** Get documents list from ChromaDB */
export async function getDocuments(scope?: string): Promise<any[]> {
  const params = scope ? `?scope=${scope}` : "";
  const data = await fetchJson(`${CHROMA_URL}/documents${params}`);
  return data?.documents ?? [];
}

/** Get all memories */
export async function getMemories(userId?: string): Promise<MemoryResult[]> {
  const params = userId ? `?user_id=${userId}` : "";
  const data = await fetchJson(`${MEMORY_URL}/memories${params}`);
  return data?.memories ?? [];
}

/** Delete a memory */
export async function deleteMemory(id: string): Promise<boolean> {
  const data = await fetchJson(`${MEMORY_URL}/memory/${id}`, { method: "DELETE" });
  return data?.ok ?? false;
}

/** Trigger ChromaDB reindex — longer timeout because full index of 100+ files takes 10-30s */
export async function reindexDocs(): Promise<any> {
  return await fetchJson(`${CHROMA_URL}/reindex`, { method: "POST" }, 90000);
}

/**
 * Map session key to a / scope.
 * Reads scope patterns from config.yaml jarvis.memoryScopePatterns.
 * Each entry maps a scope name to an array of substrings to match in the session key.
 * Example config:
 *   jarvis:
 *     memoryScopePatterns:
 *       family: ["familychat", "<whatsapp-group-jid>"]
 *       work: ["workchat"]
 * Falls back to "business" if no pattern matches.
 */
export function scopeFromKey(key: string): string {
  const k = key.toLowerCase();

  try {
    const { readRawConfig } = require("./config-loader");
    const raw = readRawConfig();
    const patterns: Record<string, string[]> = raw?.jarvis?.memoryScopePatterns ?? {};
    for (const [scope, matchers] of Object.entries(patterns)) {
      if (Array.isArray(matchers) && matchers.some((m: string) => k.includes(String(m).toLowerCase()))) {
        return scope;
      }
    }
  } catch { /* config not loaded yet */ }

  return "business";
}
