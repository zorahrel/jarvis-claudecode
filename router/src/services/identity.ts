/**
 * Sender identity resolution against the `users:` registry in config.yaml.
 *
 * The router already parses `users:` into Config.users (owner/team/family/
 * personal/client + per-channel ids), but until now nothing consumed it — so
 * the agent had no idea *who* (in human, role-aware terms) was writing on a
 * shared channel. This module turns an incoming sender id into a known person
 * with a role, which the conversation-context header surfaces to the model.
 *
 * Id shapes per channel (must match IncomingMessage.from):
 *   - telegram: numeric user id as string  (e.g. "502955633")
 *   - discord:  author snowflake id         (e.g. "921140221473603624")
 *   - whatsapp: phone in "+39…" form        (e.g. "+393313998288")
 *
 * For WhatsApp, a `users:` entry may also map to a GROUP jid (a whole chat that
 * represents one client) — resolveChat covers that case for the location label.
 */
import type { Channel, User } from "../types";
import { getConfig } from "./config-loader";

export type UserRole = User["type"]; // "owner" | "team" | "family" | "personal" | "client"

export interface ResolvedUser {
  /** Canonical short key from config (e.g. "attilio"). */
  key: string;
  /** Display name — the capitalized config key. */
  name: string;
  role: UserRole;
}

function readUsers(): Record<string, User> {
  try {
    return getConfig().users ?? {};
  } catch {
    return {};
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Pure resolver — match an id against a given users map. Exported for tests so
 * resolution can be exercised without loading the live config.
 */
export function resolveUserFrom(
  users: Record<string, User>,
  channel: Channel,
  id: string | undefined,
): ResolvedUser | null {
  if (id == null) return null;
  const want = String(id);
  for (const [key, u] of Object.entries(users)) {
    const cid = u.ids?.[channel];
    if (cid !== undefined && String(cid) === want) {
      return { key, name: capitalize(key), role: u.type };
    }
  }
  return null;
}

/**
 * Resolve the *sender* of a message to a known user, or null if unknown.
 * `id` is IncomingMessage.from (channel-specific, see module header).
 */
export function resolveSender(channel: Channel, id: string | undefined): ResolvedUser | null {
  return resolveUserFrom(readUsers(), channel, id);
}

/**
 * Resolve a *chat/group id* to a known user (used when a whole chat maps to a
 * single person/client, e.g. a WhatsApp group jid registered under `users:`).
 */
export function resolveChat(channel: Channel, chatId: string | undefined): ResolvedUser | null {
  return resolveUserFrom(readUsers(), channel, chatId);
}

export function isOwner(channel: Channel, id: string | undefined): boolean {
  return resolveSender(channel, id)?.role === "owner";
}
