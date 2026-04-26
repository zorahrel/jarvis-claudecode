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

/**
 * ASCII-only footer aligned with `services/timings.ts` `formatTimingFooter`
 * (`[t X | tok N>M | agent/model]`) so a child notification visually matches
 * the regular agent footer with a `child` marker appended (and
 * `child:failed` / `child:canceled` for non-completed paths).
 *
 * Sections are omitted when data isn't available, matching how
 * `formatTimingFooter` already drops empty sections. `tok` is currently
 * always omitted — the CLI's task-notification envelope doesn't carry
 * subagent token usage, so we'd be making numbers up.
 *
 * Examples:
 *   [t 8.4s | jarvis/opus | child]
 *   [jarvis/opus | child:failed]      // start time wasn't captured
 *   [child]                            // last-resort fallback
 */
export function formatChildNotificationFooter(
  env: TaskNotificationEnvelope,
  agent?: string,
  model?: string,
  durationMs?: number,
): string {
  const parts: string[] = [];
  if (typeof durationMs === "number" && durationMs >= 0) {
    parts.push(`t ${fmtMs(durationMs)}`);
  }
  if (agent && model) parts.push(`${agent}/${model}`);
  else if (agent) parts.push(agent);
  else if (model) parts.push(model);
  parts.push(env.status === "completed" ? "child" : `child:${env.status}`);
  return `[${parts.join(" | ")}]`;
}
