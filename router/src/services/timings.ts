import type { MessageTimings } from "../types/message";

/** Format a duration in milliseconds as a human-readable string */
function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a token count with k/M suffixes */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Build a compact timing footer to append at the end of a reply.
 * Uses ASCII-only symbols so every messenger (TG/WA/Discord) renders it
 * identically without needing a parse mode.
 *
 * Example output:
 *   [t 8.4s | media 2.3s + llm 5.8s + send 0.3s | tok 47k>214 | simone/opus]
 */
export function formatTimingFooter(
  t: MessageTimings,
  agent?: string,
  model?: string,
  inputTokens?: number,
  outputTokens?: number,
): string {
  const phases: { label: string; ms: number }[] = [];

  if (t.mediaStart && t.mediaEnd) {
    phases.push({ label: "media", ms: t.mediaEnd - t.mediaStart });
  }
  if (t.llmStart && t.llmEnd) {
    phases.push({ label: "llm", ms: t.llmEnd - t.llmStart });
  }
  if (t.sendStart && t.sendEnd) {
    phases.push({ label: "send", ms: t.sendEnd - t.sendStart });
  }

  // Compute unaccounted time (routing/io overhead)
  const end = t.sendEnd ?? t.llmEnd ?? Date.now();
  const total = end - t.received;
  const accounted = phases.reduce((sum, p) => sum + p.ms, 0);
  const ioMs = total - accounted;
  if (ioMs > 200) {
    phases.push({ label: "io", ms: ioMs });
  }

  const parts: string[] = [];
  const phasesStr = phases.map(p => `${p.label} ${fmt(p.ms)}`).join(" + ");
  parts.push(phases.length > 0 ? `t ${fmt(total)} = ${phasesStr}` : `t ${fmt(total)}`);

  // Append tokens (use ">" instead of "→" for ASCII safety)
  if (inputTokens !== undefined && outputTokens !== undefined) {
    parts.push(`tok ${fmtTokens(inputTokens)}>${fmtTokens(outputTokens)}`);
  }

  // Append agent/model
  if (agent || model) {
    if (agent && model) parts.push(`${agent}/${model}`);
    else if (agent) parts.push(agent);
    else if (model) parts.push(model);
  }

  return `[${parts.join(" | ")}]`;
}

/** Append the timing footer to a reply text (plain text, no markdown styling) */
export function appendTimingFooter(
  text: string,
  timings?: MessageTimings,
  agent?: string,
  model?: string,
): string {
  if (!timings) return text;
  const footer = formatTimingFooter(timings, agent, model);
  return `${text}\n\n${footer}`;
}
