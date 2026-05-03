import type { AgentConfig } from "../types";

/** Check if an agent has a specific tool enabled (or has fullAccess which grants everything). */
export function hasTool(agent: AgentConfig | undefined, toolId: string): boolean {
  if (!agent) return false;
  return agent.fullAccess === true || (agent.tools ?? []).includes(toolId);
}

export function canVision(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "vision");
}

/**
 * Local vision via Moondream Station (port 2020). Independent from
 * `vision`: the latter lets Claude read images via its Read tool, while
 * `vision-local` pre-captions/queries images on-device so the upstream
 * model gets a textual brief alongside the image. They compose — enabling
 * both gives Claude a Moondream caption AND the raw file path.
 */
export function canVisionLocal(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "vision-local");
}

export function canVoice(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "voice");
}
