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

export function canDiscord(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "discord") || hasTool(agent, "discord:write");
}
export function canDiscordWrite(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "discord:write");
}

export function canWhatsapp(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "whatsapp") || hasTool(agent, "whatsapp:write");
}
export function canWhatsappWrite(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "whatsapp:write");
}

export function canTelegram(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "telegram") || hasTool(agent, "telegram:write");
}
export function canTelegramWrite(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "telegram:write");
}

export function canChannels(agent: AgentConfig | undefined): boolean {
  return hasTool(agent, "channels");
}
