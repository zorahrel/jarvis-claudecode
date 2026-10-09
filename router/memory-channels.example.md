# Messaging channels — Jarvis registry

> **Curated** list of known Discord channels, WhatsApp chats, and Telegram chats.
> Read by the in-process `channels` MCP (`router/src/mcp/channels.ts`) so Jarvis
> can resolve a human name like "Example Ops" to the correct ID/JID without
> guessing.
>
> The first ` ```yaml ` fenced block below is parsed as the data source. Edit
> by hand — keep the structure tidy, one entry per channel/chat. Add `tags:`
> for fuzzy lookup; descriptions improve the agent's reasoning quality.
>
> Rename this file to `channels.md` and start filling it in. Until it exists,
> `channels_list_known` returns an empty list and `channels_resolve` always
> reports "no match".

```yaml
channels:
  # ─── Discord (example guild) ────────────────────────────────────────────
  - name: management
    channel: discord
    id: "000000000000000000"
    guildId: "000000000000000000"
    description: Team discussion channel
    tags: [internal, ops]

  - name: development
    channel: discord
    id: "000000000000000001"
    guildId: "000000000000000000"
    tags: [eng]

  # ─── WhatsApp groups ────────────────────────────────────────────────────
  - name: Example Ops
    channel: whatsapp
    id: "120363000000000000@g.us"
    description: Deploy/migration coordination
    tags: [ops, deploy]

  # ─── Telegram chats (only those captured during router uptime are readable) ─
  # - name: ai-news
  #   channel: telegram
  #   id: "-1001234567890"
  #   tags: [news]
```

## Notes

- **Discord IDs** are 17-19 digit Snowflakes. Find them by enabling Developer
  Mode in Discord settings → right-click → Copy ID.
- **WhatsApp JIDs** end in `@g.us` (group) or `@s.whatsapp.net` (DM). Find them
  via the `whatsapp_list_chats` MCP tool, or look at `state/whatsapp-history/`
  filenames after a few messages have been received.
- **Telegram chat IDs** are negative for groups/supergroups. Find them by sending
  a message to the bot or via `getUpdates`.
- Cross-channel scoping (allowedGuilds, allowedJids, etc) is configured per-agent
  in `agents/<name>/agent.yaml` — this file is just a discovery layer.
