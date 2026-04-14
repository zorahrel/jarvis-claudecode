import { resolve } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { logger } from "./logger";

const log = logger.child({ module: "pid" });

const PID_FILE = resolve(homedir(), ".claude/jarvis/router/jarvis-router.pid");

/** Check for existing process and write PID file. Exits if already running. */
export function acquirePid(): void {
  if (existsSync(PID_FILE)) {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (existingPid && isProcessAlive(existingPid)) {
      log.fatal({ pid: existingPid }, "Another instance is already running");
      process.exit(1);
    }
    log.warn({ pid: existingPid }, "Stale PID file found — cleaning up");
    unlinkSync(PID_FILE);
  }

  writeFileSync(PID_FILE, String(process.pid));
  log.info({ pid: process.pid }, "PID file written");
}

/** Remove PID file on shutdown */
export function releasePid(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
      log.info("PID file removed");
    }
  } catch {
    // Best effort
  }
}

/** Check if a process is alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
