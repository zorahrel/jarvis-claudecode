import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "cost-tracker" });

export interface CostEntry {
  ts: number;
  route: string;
  channel: string;
  from: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  costUsd: number;
  durationMs: number;
  apiDurationMs: number;
}

export interface AggregateResult {
  key: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  count: number;
}

const COSTS_FILE = join(process.cwd(), "data", "costs.jsonl");

// In-memory cache — loaded once at boot, appended on each record
let entries: CostEntry[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(COSTS_FILE)) return;
    const raw = readFileSync(COSTS_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    log.info({ count: entries.length }, "Loaded cost log from disk");
  } catch (err) {
    log.warn({ err }, "Failed to load cost log — starting fresh");
  }
}

export function recordCost(entry: CostEntry): void {
  ensureLoaded();
  entries.push(entry);
  try {
    const dir = dirname(COSTS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(COSTS_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    log.warn({ err }, "Failed to persist cost entry");
  }
}

export function queryCosts(opts: {
  from?: number;
  to?: number;
  route?: string;
  channel?: string;
}): CostEntry[] {
  ensureLoaded();
  return entries.filter(e => {
    if (opts.from && e.ts < opts.from) return false;
    if (opts.to && e.ts > opts.to) return false;
    if (opts.route && e.route !== opts.route) return false;
    if (opts.channel && e.channel !== opts.channel) return false;
    return true;
  });
}

export function aggregateCosts(opts: {
  from?: number;
  to?: number;
  route?: string;
  groupBy: "route" | "channel" | "day" | "model";
}): AggregateResult[] {
  const filtered = queryCosts(opts);
  const groups = new Map<string, AggregateResult>();

  for (const e of filtered) {
    let key: string;
    switch (opts.groupBy) {
      case "route": key = e.route; break;
      case "channel": key = e.channel; break;
      case "model": key = e.model; break;
      case "day": key = new Date(e.ts).toISOString().slice(0, 10); break;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.totalCost += e.costUsd;
      existing.totalInputTokens += e.inputTokens;
      existing.totalOutputTokens += e.outputTokens;
      existing.count++;
    } else {
      groups.set(key, {
        key,
        totalCost: e.costUsd,
        totalInputTokens: e.inputTokens,
        totalOutputTokens: e.outputTokens,
        count: 1,
      });
    }
  }

  return [...groups.values()].sort((a, b) => b.totalCost - a.totalCost);
}

/** Get total cost for all entries */
export function getTotalCost(): { totalCost: number; count: number } {
  ensureLoaded();
  const totalCost = entries.reduce((s, e) => s + e.costUsd, 0);
  return { totalCost, count: entries.length };
}
