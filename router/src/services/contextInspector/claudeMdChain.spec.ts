import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { expandClaudeMdChain } from "./claudeMdChain.js";

let tmpDir: string;
const tmpDirsToCleanup: string[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "claudemd-chain-test-"));
  tmpDirsToCleanup.push(tmpDir);
});

after(async () => {
  for (const d of tmpDirsToCleanup) {
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("expandClaudeMdChain: root + 2 chained @-imports (absolute paths)", async () => {
  const soulPath = join(tmpDir, "SOUL.md");
  const agentsPath = join(tmpDir, "AGENTS.md");
  const rootPath = join(tmpDir, "CLAUDE.md");

  await fs.writeFile(soulPath, "# soul content\n");
  await fs.writeFile(agentsPath, "# agents content lorem ipsum\n");
  await fs.writeFile(
    rootPath,
    `@${soulPath}\n@${agentsPath}\n# root content here\n`,
  );

  const r = await expandClaudeMdChain(rootPath);

  assert.equal(r.entries.length, 3, "root + 2 imports = 3 entries");
  assert.equal(r.entries[0].isRoot, true, "first entry is root");
  assert.equal(r.entries[0].path, rootPath);
  assert.equal(r.entries[1].path, soulPath);
  assert.equal(r.entries[2].path, agentsPath);
  assert.equal(r.missing.length, 0, "no missing files");
  assert.ok(r.totalBytes > 0);
  assert.equal(r.totalTokens, Math.ceil(r.totalBytes / 4));
});

test("expandClaudeMdChain: cycle detection (A imports B imports A)", async () => {
  const aPath = join(tmpDir, "A.md");
  const bPath = join(tmpDir, "B.md");

  await fs.writeFile(aPath, `@${bPath}\nA content\n`);
  await fs.writeFile(bPath, `@${aPath}\nB content\n`);

  const r = await expandClaudeMdChain(aPath);

  // Each file visited exactly once
  assert.equal(r.entries.length, 2);
  const paths = r.entries.map((e) => e.path).sort();
  assert.deepEqual(paths, [aPath, bPath].sort());
});

test("expandClaudeMdChain: missing @-import recorded in missing[], not thrown", async () => {
  const rootPath = join(tmpDir, "CLAUDE.md");
  await fs.writeFile(rootPath, "@/does/not/exist.md\n# root\n");

  const r = await expandClaudeMdChain(rootPath);

  assert.equal(r.entries.length, 1, "only root parsed");
  assert.equal(r.entries[0].isRoot, true);
  assert.equal(r.missing.length, 1);
  assert.ok(r.missing[0].endsWith("/does/not/exist.md"));
});

test("expandClaudeMdChain: tilde expansion ~/.something maps to homedir", async () => {
  // Create a file in homedir for the test, then clean up
  const homeFile = join(homedir(), `.claudemd-chain-test-${Date.now()}.md`);
  await fs.writeFile(homeFile, "# home file\n");
  tmpDirsToCleanup.push(homeFile); // tracked for cleanup (we reuse the array)

  const rootPath = join(tmpDir, "CLAUDE.md");
  const tildeRef = `~/${homeFile.split("/").pop()!}`;
  await fs.writeFile(rootPath, `@${tildeRef}\n`);

  try {
    const r = await expandClaudeMdChain(rootPath);
    assert.equal(r.entries.length, 2, "root + tilde-expanded entry");
    assert.equal(r.entries[1].path, homeFile);
    assert.equal(r.missing.length, 0);
  } finally {
    await fs.rm(homeFile, { force: true });
  }
});

test("expandClaudeMdChain: token estimate per entry uses Math.ceil(bytes / 4)", async () => {
  const rootPath = join(tmpDir, "CLAUDE.md");
  const content = "x".repeat(100); // 100 bytes
  await fs.writeFile(rootPath, content);

  const r = await expandClaudeMdChain(rootPath);
  assert.equal(r.entries[0].bytes, 100);
  assert.equal(r.entries[0].tokens, 25); // ceil(100/4) = 25
});

test("expandClaudeMdChain: totalBytes equals sum of individual entry bytes", async () => {
  const a = join(tmpDir, "a.md");
  const b = join(tmpDir, "b.md");
  await fs.writeFile(a, "x".repeat(50));
  await fs.writeFile(b, "y".repeat(73));
  const root = join(tmpDir, "root.md");
  await fs.writeFile(root, `@${a}\n@${b}\n`);

  const r = await expandClaudeMdChain(root);
  const sumOfEntries = r.entries.reduce((s, e) => s + e.bytes, 0);
  assert.equal(r.totalBytes, sumOfEntries);
});
