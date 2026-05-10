/**
 * Phase 2 Plan 02-04 — audit.ts unit tests (ORC-17).
 *
 * Tests run against a tmpdir set via JARVIS_AUDIT_DIR. The audit module
 * resolves the directory dynamically inside appendAudit() so each test
 * scopes its own write target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("appendAudit writes a JSON line to AUDIT_FILE_PATH", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "audit-"));
  process.env.JARVIS_AUDIT_DIR = tmp;
  const { appendAudit } = await import("./audit.js");
  await appendAudit({ ts: 1, pid: 1234, repo: "x", action: "inject", text: "y", source: "user-approved" });
  const content = await fs.readFile(join(tmp, "audit.jsonl"), "utf8");
  const parsed = JSON.parse(content.trim());
  assert.equal(parsed.pid, 1234);
  assert.equal(parsed.action, "inject");
});

test("appendAudit creates AUDIT_DIR if missing", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "audit-"));
  const nested = join(tmp, "deep", "nested");
  process.env.JARVIS_AUDIT_DIR = nested;
  const { appendAudit } = await import("./audit.js");
  await appendAudit({ ts: 1, pid: 1, repo: "x", action: "inject", source: "user-approved" });
  const stat = await fs.stat(join(nested, "audit.jsonl"));
  assert.ok(stat.isFile());
});

test("appendAudit rotates when file exceeds 10 MB", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "audit-rot-"));
  process.env.JARVIS_AUDIT_DIR = tmp;
  const { appendAudit, ROTATE_BYTES } = await import("./audit.js");
  const auditFile = join(tmp, "audit.jsonl");
  // Pre-fill audit.jsonl with > 10 MB of garbage so the next append triggers rotation.
  await fs.writeFile(auditFile, "x".repeat(ROTATE_BYTES + 100));
  await appendAudit({ ts: 99, pid: 1, repo: "x", action: "inject", source: "user-approved" });
  const files = (await fs.readdir(tmp)).filter((f) => f.startsWith("audit.jsonl"));
  assert.ok(files.length >= 2, "should have rotated archive");
});

test("appendAudit serializes concurrent writes via single-writer queue", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "audit-conc-"));
  process.env.JARVIS_AUDIT_DIR = tmp;
  const { appendAudit } = await import("./audit.js");
  const auditFile = join(tmp, "audit.jsonl");
  await Promise.all([
    appendAudit({ ts: 1, pid: 1, repo: "a", action: "inject", source: "user-approved" }),
    appendAudit({ ts: 2, pid: 2, repo: "b", action: "inject", source: "user-approved" }),
    appendAudit({ ts: 3, pid: 3, repo: "c", action: "inject", source: "user-approved" }),
  ]);
  const lines = (await fs.readFile(auditFile, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  // Each line must be independently parseable JSON (no interleaving).
  for (const l of lines) JSON.parse(l);
});
