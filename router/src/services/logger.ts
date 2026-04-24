import pino from "pino";

// Dashboard log buffer hook — set by dashboard/server.ts after import
let dashboardHook: ((level: string, module: string, msg: string, extra?: Record<string, unknown>) => void) | null = null;

export function setDashboardLogHook(fn: (level: string, module: string, msg: string, extra?: Record<string, unknown>) => void): void {
  dashboardHook = fn;
}

const levelNames: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

// Token redaction: JARVIS_NOTIFY_TOKEN binds to a {channel, target} pair and must never
// appear in plaintext logs. This automatic pino redaction is defense-in-depth — callers
// should also avoid passing tokens into log objects by convention, but this catches slips.
const REDACT_PATHS = [
  "token",
  "JARVIS_NOTIFY_TOKEN",
  "env.JARVIS_NOTIFY_TOKEN",
  "headers.authorization",
  "req.headers.authorization",
  "*.token",
  "*.JARVIS_NOTIFY_TOKEN",
];

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "HH:MM:ss" },
  },
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  hooks: {
    logMethod(inputArgs, method, level) {
      // Forward to dashboard log buffer
      if (dashboardHook && level >= 30) {
        try {
          const first = inputArgs[0];
          const obj: Record<string, any> = (first && typeof first === "object") ? (first as Record<string, any>) : {};
          // Interpolate printf-style placeholders (%s, %d, %o, %j)
          const rawMsg = typeof first === "string" ? first : (typeof inputArgs[1] === "string" ? (inputArgs[1] as string) : "");
          const fmtStart = typeof first === "string" ? 1 : 2;
          let ai = fmtStart;
          const msg = rawMsg.replace(/%[sdoj]/g, () => {
            if (ai < inputArgs.length) {
              const v = inputArgs[ai++];
              return typeof v === "object" ? JSON.stringify(v) : String(v);
            }
            return "%?";
          });
          const module = obj.module || (this as any)?.bindings?.()?.module || "?";
          // Collect extra fields (skip pino internals and module)
          const skip = new Set(["module", "pid", "hostname", "time", "level", "v", "msg"]);
          const extra: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            if (!skip.has(k) && v !== undefined) extra[k] = v;
          }
          dashboardHook(levelNames[level] || "info", module, msg, Object.keys(extra).length ? extra : undefined);
        } catch {}
      }
      method.apply(this, inputArgs);
    },
  },
});
