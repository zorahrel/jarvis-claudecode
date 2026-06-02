import { createDiscordMcp } from "./src/mcp/discord.ts";
const base = { agent: { discord: {} } as any, sessionKey: "test" };
function toolNames(cfg: any): string[] {
  const inst = cfg.instance ?? cfg;
  const reg = inst?._registeredTools ?? inst?.registeredTools ?? inst?._tools ?? inst?.server?._registeredTools;
  return reg ? Object.keys(reg) : [];
}
const admin = createDiscordMcp({ ...base, canWrite: true, canAdmin: true });
const noAdmin = createDiscordMcp({ ...base, canWrite: true, canAdmin: false });
let a = toolNames(admin), n = toolNames(noAdmin);
if (!a.length) { console.log("keys(admin.instance):", Object.keys((admin as any).instance ?? {})); }
console.log("with admin :", a.length, "tools |", a.length ? "admin-only: " + a.filter(x => !n.includes(x)).sort().join(", ") : "(could not introspect)");
console.log("delete gated by admin:", a.includes("discord_delete_channel") && !n.includes("discord_delete_channel") ? "✓" : (a.length ? "✗" : "n/a"));
