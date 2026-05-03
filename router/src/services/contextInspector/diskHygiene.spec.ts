import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { diskStats, recentSessions } from "./diskHygiene.js";

let tmpRoot: string;
const tmpRootsToCleanup: string[] = [];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), "diskhygiene-test-"));
  tmpRootsToCleanup.push(tmpRoot);
});

after(async () => {
  for (const d of tmpRootsToCleanup) {
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function writeAssistantJsonl(
  path: string,
  turns: number,
  perTurnTokens: { input: number; output: number; cacheCreation: number; cacheRead: number },
): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: `turn ${i}` }],
          usage: {
            input_tokens: perTurnTokens.input,
            output_tokens: perTurnTokens.output,
            cache_creation_input_tokens: perTurnTokens.cacheCreation,
            cache_read_input_tokens: perTurnTokens.cacheRead,
          },
        },
      }),
    );
  }
  await fs.writeFile(path, lines.join("\n") + "\n");
}

test("diskStats: 3 jsonl files of varying sizes", async () => {
  const slug = join(tmpRoot, "-Users-zorahrel-test-1");
  await fs.mkdir(slug, { recursive: true });
  await fs.writeFile(join(slug, "s1.jsonl"), "x".repeat(100));
  await fs.writeFile(join(slug, "s2.jsonl"), "y".repeat(200));
  await fs.writeFile(join(slug, "s3.jsonl"), "z".repeat(300));

  const stats = await diskStats(tmpRoot);
  assert.equal(stats.totalJsonl, 3);
  assert.equal(stats.filesOlderThan30d, 0);
  assert.ok(stats.totalMb >= 600 / 1024 / 1024 - 0.0001);
  assert.ok(stats.totalMb <= 600 / 1024 / 1024 + 0.0001);
});

test("diskStats: file with mtime 31 days ago counted as older-than-30d", async () => {
  const slug = join(tmpRoot, "-Users-zorahrel-test-2");
  await fs.mkdir(slug, { recursive: true });
  const oldFile = join(slug, "old.jsonl");
  await fs.writeFile(oldFile, "old");
  const oldMtime = (Date.now() - 31 * 86400 * 1000) / 1000; // seconds
  await fs.utimes(oldFile, oldMtime, oldMtime);

  await fs.writeFile(join(slug, "new.jsonl"), "new");

  const stats = await diskStats(tmpRoot);
  assert.equal(stats.totalJsonl, 2);
  assert.equal(stats.filesOlderThan30d, 1);
});

test("diskStats: missing dir returns zeros (no throw)", async () => {
  const stats = await diskStats("/tmp/this-dir-definitely-does-not-exist-xyz");
  assert.deepEqual(stats, { totalMb: 0, totalJsonl: 0, filesOlderThan30d: 0 });
});

test("recentSessions: returns ordered list with enriched metadata", async () => {
  const slug = join(tmpRoot, "-Users-zorahrel-projects-test");
  await fs.mkdir(slug, { recursive: true });

  const olderPath = join(slug, "older.jsonl");
  await writeAssistantJsonl(olderPath, 2, {
    input: 100,
    output: 50,
    cacheCreation: 0,
    cacheRead: 0,
  });
  // Backdate older file
  const oldTime = (Date.now() - 60 * 1000) / 1000;
  await fs.utimes(olderPath, oldTime, oldTime);

  const newerPath = join(slug, "newer.jsonl");
  await writeAssistantJsonl(newerPath, 3, {
    input: 200,
    output: 100,
    cacheCreation: 1000,
    cacheRead: 5000,
  });

  const sessions = await recentSessions(tmpRoot, 10);
  assert.equal(sessions.length, 2);
  // Newer first
  assert.equal(sessions[0].sessionId, "newer");
  assert.equal(sessions[1].sessionId, "older");
  assert.ok(sessions[0].mtime > sessions[1].mtime);
  // Enrichment populated
  assert.ok(sessions[0].totalTokens > 0);
  assert.equal(sessions[0].turnCount, 3);
  assert.equal(sessions[0].compactionCount, 0);
  assert.ok(sessions[0].sizeBytes > 0);
});

test("recentSessions: limit=5 caps results even if more exist", async () => {
  const slug = join(tmpRoot, "-many-sessions");
  await fs.mkdir(slug, { recursive: true });
  for (let i = 0; i < 10; i++) {
    await writeAssistantJsonl(join(slug, `s${i}.jsonl`), 1, {
      input: 1,
      output: 1,
      cacheCreation: 0,
      cacheRead: 0,
    });
  }

  const sessions = await recentSessions(tmpRoot, 5);
  assert.equal(sessions.length, 5);
});

test("recentSessions: routeHint extracted from /jarvis/agents/<NAME> slug", async () => {
  const slug = join(tmpRoot, "-Users-zorahrel--claude-jarvis-agents-notch");
  await fs.mkdir(slug, { recursive: true });
  await writeAssistantJsonl(join(slug, "s1.jsonl"), 1, {
    input: 1,
    output: 1,
    cacheCreation: 0,
    cacheRead: 0,
  });

  const sessions = await recentSessions(tmpRoot, 10);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].routeHint, "notch");
});
