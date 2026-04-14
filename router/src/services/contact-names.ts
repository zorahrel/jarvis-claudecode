/**
 * Shared cache for human-readable names of groups, users, and channels.
 * Connectors populate this at startup and on incoming messages.
 * Dashboard reads it for friendly display.
 */
const names = new Map<string, string>();

export function setContactName(id: string, name: string): void {
  if (id && name) names.set(id, name);
}

export function getContactName(id: string): string | undefined {
  return names.get(id);
}

export function getAllContactNames(): Record<string, string> {
  return Object.fromEntries(names);
}
