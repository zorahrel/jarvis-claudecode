import type { Route, IncomingMessage, AgentConfig } from "../types";
import { getConfig, getAgentRegistry } from "./config-loader";
import { logger } from "./logger";

const log = logger.child({ module: "router" });

/**
 * Return the full-access agent config.
 *
 * Strategy: iterate the agent registry and return the first one with
 * fullAccess: true. Single source of truth — change `agent.yaml` in one
 * folder and every path (explicit route, @jarvis override, CLI wrapper)
 * follows.
 *
 * Fallback: a sensible default pointing to agents/jarvis.
 */
export function getFullAgent(): AgentConfig {
  const registry = getAgentRegistry();
  for (const agent of Object.values(registry)) {
    if (agent.fullAccess) return { ...agent };
  }
  // Fallback (should never hit in practice)
  return {
    name: "jarvis",
    workspace: `${process.env.HOME}/.claude/jarvis/agents/jarvis`,
    model: "opus",
    effort: "high",
    fallbacks: ["haiku"],
    fullAccess: true,
  };
}

/** Find the first matching route for an incoming message */
export function findRoute(msg: IncomingMessage): Route | null {
  const { routes } = getConfig();

  for (const route of routes) {
    const m = route.match;

    // Channel must match (or wildcard)
    if (m.channel !== "*" && m.channel !== msg.channel) continue;

    // JID direct match (highest priority for WhatsApp LID, self-chat, etc.)
    if (m.jid) {
      if ((msg as any).rawJid !== m.jid) continue;
      log.debug({ channel: msg.channel, jid: m.jid }, "Route matched by JID");
      return route;
    }

    // Group/guild match
    if (m.group && m.group !== msg.group) continue;
    if (m.guild && m.guild !== msg.group) continue;

    // From match
    if (m.from !== undefined) {
      const fromStr = String(m.from);
      if (fromStr === "self") {
        // "self" matches are handled by the connector setting from="self"
        if (msg.from !== "self") continue;
      } else if (fromStr !== msg.from) {
        continue;
      }
    }

    // If no from/group/guild specified, it matches any sender on that channel
    if (!m.from && !m.group && !m.guild && m.channel !== "*") {
      // Channel-wide catch-all — matches
    }

    log.debug({ channel: msg.channel, from: msg.from, route: m }, "Route matched");
    return route;
  }

  log.debug({ channel: msg.channel, from: msg.from }, "No route matched");
  return null;
}
