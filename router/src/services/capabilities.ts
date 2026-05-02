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
