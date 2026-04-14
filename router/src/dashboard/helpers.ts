import { readFileSync, statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";

export function corsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin ?? "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

export function json(req: IncomingMessage, res: ServerResponse, data: unknown, status = 200): void {
  const origin = corsOrigin(req);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function safeReadFile(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

export function safeFileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function validateAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_.\-]+$/.test(name) && !name.includes("..");
}

export function parseBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export function requireConfirm(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers["x-confirm"] !== "true") {
    json(req, res, { error: "X-Confirm: true header required" }, 400);
    return false;
  }
  return true;
}
