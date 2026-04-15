import { homedir } from "os";
import { join, resolve } from "path";
import type { ServiceDef, ServiceLaunchd } from "../types";
import { getConfig, expandHome } from "./config-loader";
import { logger } from "./logger";

const log = logger.child({ module: "services" });

const LABEL_REGEX = /^[a-z][a-z0-9._-]{0,63}$/;
const ROUTER_DIR = join(homedir(), ".claude/jarvis/router");
const LOG_DIR = join(homedir(), ".claude/jarvis/logs");
const HOME_ENV_PATH = `${homedir()}/.nvm/versions/node/v25.5.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

/** 3 services always present (no config required). */
export function getCoreServices(): ServiceDef[] {
  return [
    {
      name: "Router",
      port: 3340,
      healthUrl: "http://localhost:3340/api/stats",
      linkUrl: "http://localhost:3340",
      launchd: {
        label: "com.jarvis.router",
        args: [
          `${homedir()}/.nvm/versions/node/v25.5.0/bin/node`,
          `${homedir()}/.nvm/versions/node/v25.5.0/bin/tsx`,
          "src/index.ts",
        ],
        cwd: ROUTER_DIR,
        logName: "router",
      },
    },
    {
      name: "ChromaDB",
      port: 3342,
      healthUrl: "http://localhost:3342/health",
      launchd: {
        label: "com.jarvis.chroma",
        args: ["/opt/homebrew/bin/python3", "-u", "scripts/chroma-server.py"],
        cwd: ROUTER_DIR,
        logName: "chroma",
      },
    },
    {
      name: "OMEGA",
      port: 3343,
      healthUrl: "http://localhost:3343/health",
      launchd: {
        label: "com.jarvis.omega",
        args: ["scripts/omega-env/bin/python3", "-u", "scripts/omega-server.py"],
        cwd: ROUTER_DIR,
        logName: "omega",
      },
    },
  ];
}

/**
 * Validate a user-provided ServiceDef. Logs and skips invalid ones.
 * Returns a sanitized clone with expanded paths, or null if invalid.
 */
function validateServiceDef(def: ServiceDef): ServiceDef | null {
  if (!def || typeof def !== "object") return null;
  if (!def.name || typeof def.name !== "string") {
    log.warn({ def }, "Service missing name");
    return null;
  }
  if (!Number.isInteger(def.port) || def.port <= 0 || def.port > 65535) {
    log.warn({ name: def.name }, "Service port invalid");
    return null;
  }
  if (!def.healthUrl || typeof def.healthUrl !== "string") {
    log.warn({ name: def.name }, "Service healthUrl missing");
    return null;
  }
  const clean: ServiceDef = {
    name: def.name,
    port: def.port,
    healthUrl: def.healthUrl,
    linkUrl: def.linkUrl,
  };
  if (def.launchd) {
    const ld = def.launchd;
    if (!LABEL_REGEX.test(ld.label ?? "")) {
      log.warn({ name: def.name, label: ld.label }, "Service launchd label invalid (must match ^[a-z][a-z0-9._-]{0,63}$)");
      return null;
    }
    if (!Array.isArray(ld.args) || ld.args.length === 0 || !ld.args.every(a => typeof a === "string")) {
      log.warn({ name: def.name }, "Service launchd args must be non-empty string[]");
      return null;
    }
    if (!ld.cwd || typeof ld.cwd !== "string") {
      log.warn({ name: def.name }, "Service launchd cwd missing");
      return null;
    }
    if (ld.cwd.includes("..")) {
      log.warn({ name: def.name, cwd: ld.cwd }, "Service launchd cwd contains '..'");
      return null;
    }
    // Expand ~/ in cwd and args
    const expandedArgs = ld.args.map(a => a.startsWith("~/") ? resolve(homedir(), a.slice(2)) : a);
    const expandedCwd = expandHome(ld.cwd);
    clean.launchd = {
      label: ld.label,
      args: expandedArgs,
      cwd: expandedCwd,
      logName: ld.logName ?? ld.label,
    };
  }
  return clean;
}

/** Core services + validated user services from config.yaml. */
export function getAllServices(): ServiceDef[] {
  const core = getCoreServices();
  let user: ServiceDef[] = [];
  try {
    const config = getConfig();
    if (Array.isArray(config.services)) {
      user = config.services
        .map(validateServiceDef)
        .filter((s): s is ServiceDef => s !== null);
    }
  } catch {
    // Config not loaded yet
  }
  return [...core, ...user];
}

/** XML-escape a string for safe interpolation in plist content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate launchd plist XML for a service. Values are XML-escaped.
 * Throws if the service has no launchd config.
 */
export function generatePlist(svc: ServiceDef): string {
  if (!svc.launchd) throw new Error(`Service ${svc.name} has no launchd config`);
  const ld = svc.launchd;
  const argsXML = ld.args.map(a => `        <string>${xmlEscape(a)}</string>`).join("\n");
  const logName = xmlEscape(ld.logName ?? ld.label);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(ld.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXML}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(ld.cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(LOG_DIR)}/${logName}.log</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(LOG_DIR)}/${logName}-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xmlEscape(HOME_ENV_PATH)}</string>
        <key>HOME</key>
        <string>${xmlEscape(homedir())}</string>
    </dict>
</dict>
</plist>`;
}
