import type { AgentConfig } from "../types";

/** Check if an agent has a specific tool enabled (or has fullAccess which grants everything). */
export function hasTool(agent: AgentConfig | undefined, toolId: string): boolean {
  if (!agent) return false;
  return agent.fullAccess === true || (agent.tools ?? []).includes(toolId);
}

export function canVision(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "vision");
}

export function canVoice(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "voice");
}
