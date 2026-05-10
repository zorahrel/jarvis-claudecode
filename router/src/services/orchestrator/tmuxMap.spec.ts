/**
 * Phase 2 Plan 02-04 — tmuxMap unit tests (ORC-15, ORC-16).
 *
 * Pattern mirrors Phase 1 conventions: node:test + assert/strict + co-located
 * fixtures + injected exec function so tests never spawn real `tmux` / `ps`.
 *
 * Wave 0 — these specs are RED (tmuxMap.ts doesn't exist yet). Wave 1 makes
 * them GREEN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function makeFakeExec(samplePath: string): ExecFn {
  return async (cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return { stdout: await fs.readFile(samplePath, "utf8"), stderr: "" };
    }
    if (cmd === "ps" && args.includes("-o") && args.includes("ppid=")) {
      // Default: parent is PID 1 (terminates the walk).
      return { stdout: "1\n", stderr: "" };
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
  };
}

test("listAllPanes parses multi-session output into rows", async () => {
  const { listAllPanes } = await import("./tmuxMap.js");
  const samplePath = join(__dirname, "__fixtures__/sample-list-panes-multi.txt");
  const rows = await listAllPanes(makeFakeExec(samplePath));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], {
    pid: 52899,
    session: "work-jarvis",
    pane: "%1",
    windowIndex: 0,
    active: true,
  });
});

test("listAllPanes returns empty array on empty output", async () => {
  const { listAllPanes } = await import("./tmuxMap.js");
  const samplePath = join(__dirname, "__fixtures__/sample-list-panes-empty.txt");
  const rows = await listAllPanes(makeFakeExec(samplePath));
  assert.deepEqual(rows, []);
});

test("findPaneForPid finds direct pane match without parent walk", async () => {
  const { findPaneForPid } = await import("./tmuxMap.js");
  const samplePath = join(__dirname, "__fixtures__/sample-list-panes-multi.txt");
  const result = await findPaneForPid(52905, makeFakeExec(samplePath));
  assert.deepEqual(result, { session: "work-jarvis", pane: "%2" });
});

test("findPaneForPid walks parents to find a pane", async () => {
  // Stub ps to return a chain: 99999 → 52899 (which IS in the panes list).
  const samplePath = join(__dirname, "__fixtures__/sample-list-panes-multi.txt");
  let psCalls = 0;
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === "tmux") return { stdout: await fs.readFile(samplePath, "utf8"), stderr: "" };
    if (cmd === "ps") {
      psCalls++;
      if (args.includes("99999")) return { stdout: "52899\n", stderr: "" };
      return { stdout: "1\n", stderr: "" };
    }
    throw new Error("unexpected");
  };
  const { findPaneForPid } = await import("./tmuxMap.js");
  const result = await findPaneForPid(99999, exec);
  assert.deepEqual(result, { session: "work-jarvis", pane: "%1" });
  assert.ok(psCalls >= 1);
});

test("findPaneForPid returns null when no ancestor matches", async () => {
  const { findPaneForPid } = await import("./tmuxMap.js");
  const samplePath = join(__dirname, "__fixtures__/sample-list-panes-empty.txt");
  const result = await findPaneForPid(99999, makeFakeExec(samplePath));
  assert.equal(result, null);
});

test("sendKeys passes arg-array (never shell string) — single-line", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: "", stderr: "" }; };
  const { sendKeys } = await import("./tmuxMap.js");
  await sendKeys("%2", "y", exec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "tmux");
  assert.deepEqual(calls[0].args, ["send-keys", "-t", "%2", "--", "y", "Enter"]);
});

test("sendKeys handles multi-line text by interspersing Enter between lines", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: "", stderr: "" }; };
  const { sendKeys } = await import("./tmuxMap.js");
  await sendKeys("%2", "line1\nline2\nline3", exec);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["send-keys", "-t", "%2", "--", "line1", "Enter", "line2", "Enter", "line3", "Enter"]);
});

test("sendKeys protects against flag injection by using -- terminator", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: "", stderr: "" }; };
  const { sendKeys } = await import("./tmuxMap.js");
  await sendKeys("%2", "-malicious", exec);
  // The -- before user text must be present so tmux treats "-malicious" as text, not a flag.
  const dashIdx = calls[0].args.indexOf("--");
  const textIdx = calls[0].args.indexOf("-malicious");
  assert.ok(dashIdx !== -1 && textIdx > dashIdx, "-- must precede user-supplied text");
});
