/**
 * Background-task completion detection from Claude Code stream-json output.
 *
 * Pattern verified against Paseo's implementation
 * (packages/server/src/server/agent/providers/claude/task-notification-tool-call.ts).
 * The CLI injects a synthetic user-message containing `<task-notification>...</task-notification>`
 * with inner XML-like tags whenever a backgrounded task (`Bash(run_in_background:true)`
 * or a `Task` subagent with `run_in_background:true`) finishes. There is no
 * first-class hook for this lifecycle — Anthropic injects the notice at the
 * conversation level, bypassing the hooks pipeline (anthropics/claude-code#18544).
 *
 * This module is the pure parser. No side effects, no IO. The caller
 * (claude.ts stream handler) decides how to react.
 */

const TASK_NOTIFICATION_MARKER = "<task-notification>";
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

export type TaskNotificationStatus = "completed" | "failed" | "canceled";

export interface TaskNotificationEnvelope {
  taskId: string | null;
  /** tool_use id of the assistant turn that started this task — used to
   *  correlate with the recorded start time for elapsed reporting and to
   *  filter sync subagent calls (which also emit task-notifications) from
   *  genuinely backgrounded ones. */
  toolUseId: string | null;
  status: TaskNotificationStatus;
  summary: string | null;
  outputFile: string | null;
}

function readTag(text: string, tagName: string): string | null {
  const escaped = tagName.replace(REGEX_ESCAPE, "\\$&");
  const match = text.match(new RegExp(`<${escaped}>\\s*([\\s\\S]*?)\\s*</${escaped}>`, "i"));
  if (!match) return null;
  const inner = match[1].trim();
  return inner.length > 0 ? inner : null;
}

function normalizeStatus(raw: string | null | undefined): TaskNotificationStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "failed" || s === "error") return "failed";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "completed";
}

/** Extract a task-notification envelope from a free-text blob. */
export function parseTaskNotificationFromText(text: string): TaskNotificationEnvelope | null {
  if (!text || !text.includes(TASK_NOTIFICATION_MARKER)) return null;
  return {
    taskId: readTag(text, "task-id") ?? readTag(text, "task_id"),
    toolUseId: readTag(text, "tool-use-id") ?? readTag(text, "tool_use_id"),
    status: normalizeStatus(readTag(text, "status")),
    summary: readTag(text, "summary"),
    outputFile: readTag(text, "output-file") ?? readTag(text, "output_file"),
  };
}

/**
 * Inspect a single stream-json event and return a task-notification envelope
 * if the event carries one. Two event shapes carry the marker:
 *
 *   1. `{type: "system", subtype: "task_notification", task_id, status, summary, output_file, content}`
 *   2. `{type: "user", message: {content: ... <task-notification>...}}` — the
 *      synthetic user-message Claude injects so the model can react on its
 *      next turn. Content can be a string OR an array of blocks (tool_result
 *      blocks include the marker in their `content` field).
 *
 * Field-level data on the system event takes precedence; we fall back to
 * parsing the inner XML when fields are missing (older CLI shapes / partial
 * payloads).
 */
export function extractTaskNotificationFromEvent(event: unknown): TaskNotificationEnvelope | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, any>;

  // Shape 1 — system event with explicit subtype
  if (e.type === "system" && e.subtype === "task_notification") {
    const text = typeof e.content === "string" ? e.content : "";
    const fromText = text ? parseTaskNotificationFromText(text) : null;
    return {
      taskId: (typeof e.task_id === "string" && e.task_id.trim()) || fromText?.taskId || null,
      toolUseId:
        (typeof e.tool_use_id === "string" && e.tool_use_id.trim()) || fromText?.toolUseId || null,
      status: normalizeStatus(
        (typeof e.status === "string" && e.status) || fromText?.status || "completed",
      ),
      summary: (typeof e.summary === "string" && e.summary.trim()) || fromText?.summary || null,
      outputFile:
        (typeof e.output_file === "string" && e.output_file.trim()) || fromText?.outputFile || null,
    };
  }

  // Shape 2 — synthetic user-message in the live stream
  if (e.type === "user") {
    const message = e.message;
    if (!message) return null;
    const content = (message as Record<string, unknown>).content;
    let textContent = "";
    if (typeof content === "string") {
      textContent = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") textContent += b.text;
        if (typeof b.content === "string") textContent += b.content;
        if (typeof b.input === "string") textContent += b.input;
      }
    }
    return parseTaskNotificationFromText(textContent);
  }

  return null;
}

/** Build a short user-facing body from an envelope. No emojis. */
export function formatTaskNotificationMessage(env: TaskNotificationEnvelope): string {
  const prefix =
    env.status === "failed"
      ? "Task fallito"
      : env.status === "canceled"
        ? "Task annullato"
        : "Task completato";
  if (env.summary) return `${prefix}: ${env.summary}`;
  if (env.taskId) return `${prefix} (id: ${env.taskId.slice(0, 12)})`;
  return prefix;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Optional structured metadata captured by the stream parser. Each field is
 *  rendered only when present, mirroring `formatTimingFooter`'s drop-empty
 *  behaviour. */
export interface ChildFooterContext {
  /** Wall time the bg task spent running, ms. */
  durationMs?: number;
  /** Tool kind that started the task: 'bash' | 'task' | 'agent'. */
  kind?: string;
  /** Exit code parsed from the envelope's summary (`exit code N`). */
  exitCode?: number;
  /** Size of the output_file in bytes (Bash bg). */
  outputBytes?: number;
  /** Aggregate token usage of the subagent during this bg task.
   *  Bash bg always has 0 / undefined — shell, no LLM.
   *  Task/Agent bg accumulates from `isSidechain:true` assistant events. */
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheCreate?: number;
}

/**
 * ASCII-only footer aligned with `services/timings.ts` `formatTimingFooter`.
 * Each segment renders independently and is dropped when its data is empty
 * or zero — no `exit:0` / `out 0B` / `cache 0+0` clutter on the happy path.
 *
 * Status is conveyed by the `child` / `child:failed` / `child:canceled`
 * marker; the body of the message already echoes the CLI's own
 * "(exit code N)" summary, so we don't repeat it in the footer.
 *
 * Examples:
 *   [t 8.4s | bash | out 11B | jarvis/claude-opus-4-7 | child]
 *   [t 5s | bash | out 80B | jarvis/claude-opus-4-7 | child:failed]
 *   [t 12.3s | task | tok 42k>1.2k | cache 20k | jarvis/claude-opus-4-7 | child]
 *   [child]   // last-resort: nothing was captured
 */
export function formatChildNotificationFooter(
  env: TaskNotificationEnvelope,
  agent?: string,
  model?: string,
  ctx: ChildFooterContext = {},
): string {
  const parts: string[] = [];

  if (typeof ctx.durationMs === "number" && ctx.durationMs >= 0) {
    parts.push(`t ${fmtMs(ctx.durationMs)}`);
  }

  if (ctx.kind) parts.push(ctx.kind);

  if (typeof ctx.outputBytes === "number" && ctx.outputBytes > 0) {
    parts.push(`out ${fmtBytes(ctx.outputBytes)}`);
  }

  // Token segment for Task/Agent subagent runs (Bash bg has none).
  if (
    (typeof ctx.tokensIn === "number" && ctx.tokensIn > 0) ||
    (typeof ctx.tokensOut === "number" && ctx.tokensOut > 0)
  ) {
    parts.push(`tok ${fmtTokens(ctx.tokensIn ?? 0)}>${fmtTokens(ctx.tokensOut ?? 0)}`);
  }
  // Cache as its own segment (read+create combined to a single number when
  // one side is zero, kept split as `R+C` when both contributed). Visible
  // even on an otherwise zero-token run — heavy cache creation alone can
  // surprise the bill, which is the whole point of tracking it.
  const cacheR = ctx.cacheRead ?? 0;
  const cacheC = ctx.cacheCreate ?? 0;
  if (cacheR > 0 || cacheC > 0) {
    if (cacheR > 0 && cacheC > 0) {
      parts.push(`cache ${fmtTokens(cacheR)}+${fmtTokens(cacheC)}`);
    } else {
      parts.push(`cache ${fmtTokens(cacheR + cacheC)}`);
    }
  }

  if (agent && model) parts.push(`${agent}/${model}`);
  else if (agent) parts.push(agent);
  else if (model) parts.push(model);

  parts.push(env.status === "completed" ? "child" : `child:${env.status}`);
  return `[${parts.join(" | ")}]`;
}

/** Parse `exit code N` from a Bash task-notification summary string. */
export function parseExitCodeFromSummary(summary: string | null | undefined): number | undefined {
  if (!summary) return undefined;
  const m = summary.match(/exit code\s+(-?\d+)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}
