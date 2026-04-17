import { execFile } from "child_process";
import { promisify } from "util";
import { request as httpsRequest } from "https";
import { logger } from "../logger";
import { getConfig } from "../config-loader";
import type { LocalSession, OpenTargetId, TargetAvailability } from "./types";

const log = logger.child({ module: "localSessions:openTargets" });
const execFileAsync = promisify(execFile);

const TOPICS_URL = "https://localhost:3333/api/open-project";

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Focus an iTerm2 tab whose session has the matching TTY. */
async function openIterm(session: LocalSession): Promise<void> {
  if (!session.tty) throw new Error("no TTY for this session");
  const tty = escapeForAppleScript(session.tty);
  const script = `tell application "iTerm"
  activate
  set found to false
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if tty of aSession is "${tty}" then
          select aWindow
          select aTab
          select aSession
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if found then exit repeat
  end repeat
end tell`;
  await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
}

/** Focus a Terminal.app tab by TTY. */
async function openTerminalApp(session: LocalSession): Promise<void> {
  if (!session.tty) throw new Error("no TTY for this session");
  const tty = escapeForAppleScript(session.tty);
  const script = `tell application "Terminal"
  activate
  set targetTty to "${tty}"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTty then
        set selected of t to true
        set frontmost of w to true
        return
      end if
    end repeat
  end repeat
end tell`;
  await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
}

/** Open the session's cwd as a project tab in Topics (via the existing HTTP API). */
function openTopics(session: LocalSession): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: session.cwd });
    const req = httpsRequest(
      TOPICS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        // Topics uses a self-signed cert on localhost — accept it.
        rejectUnauthorized: false,
        timeout: 4000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`Topics returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { ok?: boolean };
            if (parsed.ok === false) reject(new Error("Topics rejected the request"));
            else resolve();
          } catch {
            resolve(); // non-JSON but 2xx — treat as success
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Topics did not respond in time"));
    });
    req.write(body);
    req.end();
  });
}

async function openFinder(session: LocalSession): Promise<void> {
  await execFileAsync("open", [session.cwd], { timeout: 3000 });
}

async function openEditor(session: LocalSession): Promise<void> {
  const cfg = getConfig();
  const editor = (cfg.jarvis as Record<string, unknown> | undefined)?.editor as string | undefined;
  const cmd = editor ?? resolveDefaultEditor();
  // shell out via `open -a <AppName>` for GUI apps, or via the CLI directly when it's a command on PATH
  if (cmd.startsWith("/Applications/") || /^[A-Z][A-Za-z ]+$/.test(cmd)) {
    await execFileAsync("open", ["-a", cmd, session.cwd], { timeout: 5000 });
  } else {
    await execFileAsync(cmd, [session.cwd], { timeout: 5000 });
  }
}

function resolveDefaultEditor(): string {
  // Heuristic chain: prefer VS Code, then Cursor, then Zed, then fall back to `code`
  for (const candidate of ["/Applications/Visual Studio Code.app", "/Applications/Cursor.app", "/Applications/Zed.app"]) {
    try {
      require("fs").accessSync(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return "code";
}

async function openPr(session: LocalSession): Promise<void> {
  if (!session.branch || session.branch === "main" || session.branch === "master") {
    throw new Error("no PR-eligible branch");
  }
  await execFileAsync("gh", ["pr", "view", "--web"], {
    cwd: session.cwd,
    timeout: 6000,
    env: process.env,
  });
}

const HANDLERS: Record<OpenTargetId, (s: LocalSession) => Promise<void>> = {
  iterm: openIterm,
  terminal: openTerminalApp,
  topics: openTopics,
  finder: openFinder,
  editor: openEditor,
  pr: openPr,
};

export async function dispatchOpenTarget(target: OpenTargetId, session: LocalSession): Promise<void> {
  const handler = HANDLERS[target];
  if (!handler) throw new Error(`unknown target: ${target}`);
  await handler(session);
  log.info({ target, pid: session.pid, cwd: session.cwd }, "opened target");
}

/** One-shot reachability check for Topics (HEAD/POST with empty path returns 400; 5xx = down). */
async function topicsReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      TOPICS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "2" },
        rejectUnauthorized: false,
        timeout: 1500,
      },
      (res) => {
        // Any response — even 4xx — means Topics is up and handling requests.
        resolve((res.statusCode ?? 0) < 500);
        res.resume();
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write("{}");
    req.end();
  });
}

/**
 * Return availability for every target for a given session.
 * Dashboard uses this to enable/disable quick-action buttons.
 */
export async function availableTargets(session: LocalSession): Promise<TargetAvailability[]> {
  const [topics] = await Promise.all([topicsReachable()]);
  const hasBranch = !!session.branch && session.branch !== "main" && session.branch !== "master";
  return [
    {
      id: "iterm",
      label: "iTerm",
      available: !!session.tty,
      reason: session.tty ? undefined : "no TTY",
    },
    {
      id: "terminal",
      label: "Terminal",
      available: !!session.tty,
      reason: session.tty ? undefined : "no TTY",
    },
    {
      id: "topics",
      label: "Topics",
      available: topics,
      reason: topics ? undefined : "Topics not running on :3333",
    },
    { id: "finder", label: "Finder", available: true },
    { id: "editor", label: "Editor", available: true },
    {
      id: "pr",
      label: "PR",
      available: hasBranch,
      reason: hasBranch ? undefined : "no feature branch",
    },
  ];
}
