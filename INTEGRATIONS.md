# Integrations — Messaging MCP matrix

Jarvis exposes each connected channel (Discord, WhatsApp, Telegram) as an
in-process MCP server, so agents can read and write conversations through tool
calls instead of relying on connector-injected prompt context. The MCPs are
built on demand at session-spawn time and reuse the live connector handles —
no extra processes, no extra bot tokens, no new ports.

## Channel capability matrix

| Channel  | Read history             | Search       | Send | React | Backend                                            |
|----------|--------------------------|--------------|------|-------|----------------------------------------------------|
| Discord  | Deep (REST API)          | Linear scan  | ✓    | ✓     | discord.js Client (existing)                       |
| WhatsApp | ~14d on pair + live + backfill | Substring | ✓    | ✓     | live Baileys events + JSONL store + fetchMessageHistory |
| Telegram | Router-uptime ring       | Substring    | ✓    | —     | grammy bot + persisted ring buffer                 |
| Notch    | n/a (agent IS the conversation)                                                                            |

Discord history is fetched on-demand via the Discord REST API (paginated,
unlimited depth). **WhatsApp** uses the same Baileys session paired via the
dashboard — no second authentication. The store is populated from three
Baileys event sources: `messaging-history.set` (~14 days dump on pair),
`messages.upsert` (live, including bot's own outbound), and
`fetchMessageHistory(...)` (on-demand backfill via the `whatsapp_backfill`
tool). Persisted as per-chat JSONL in `state/whatsapp-history/<sha1(jid)>.jsonl`.
Telegram bot API has no history endpoint, so we capture every received message
into a per-chat ring buffer (`state/telegram-buffer.json`); messages that
arrived before the buffer existed are unreachable.

## Tool surface

### Discord (`discord` / `discord:write`)

Read tools (with `discord` or `discord:write`):
- `discord_read_channel` — last N messages, paginated by `before`/`after`.
- `discord_search_channel` — substring scan across recent history.
- `discord_get_message` — single message + reactions + attachments.
- `discord_list_channels` — text channels in a guild.
- `discord_list_members` — members of a guild.

Write tools (require `discord:write`):
- `discord_send_message` — send to a channel; cross-channel send needs `allowCrossChatWrite: true`.
- `discord_react` — add an emoji reaction.
- `discord_edit_own` — edit a message previously sent by the bot.
- `discord_delete_own` — delete a message previously sent by the bot.

### WhatsApp (`whatsapp` / `whatsapp:write`)

Read tools:
- `whatsapp_read_chat` — last N messages from a chat (paginated by `before`).
- `whatsapp_search` — substring search over the local store (live + history-sync + backfill).
- `whatsapp_list_chats` — known chats with optional name/JID filter.

Write tools (require `whatsapp:write`):
- `whatsapp_send_message` — text only (media-send via existing `sendFile` flow).
- `whatsapp_react` — emoji reaction (empty string to remove).
- `whatsapp_backfill` — kicks `sock.fetchMessageHistory(...)` to pull deeper
  history. Results land asynchronously via `messages.upsert` — call
  `whatsapp_read_chat` again after a short delay to see them.

### Telegram (`telegram` / `telegram:write`)

Read tools — buffer-only:
- `telegram_read_chat` — last N from local buffer.
- `telegram_search` — substring across local buffer.
- `telegram_list_chats` — chats with messages in the buffer.

Write tools (require `telegram:write`):
- `telegram_send_message` — text to a chat.

### Channels registry (`channels`)

Cross-channel lookup of human names → IDs. Reads from
`~/.claude/jarvis/memory/channels.md` (curated by you).
- `channels_list_known` — list all curated channels with optional channel/query filter.
- `channels_resolve` — fuzzy-resolve a human name to its ID/JID/chat ID.

## Security model

**Two-tier tool gating.** A read-only flag (`discord`, `whatsapp`, `telegram`,
`channels`) grants the read tools; the corresponding `:write` flag grants the
write tools on top. `fullAccess: true` grants everything.

**Per-route allow/deny lists.** Configure in `agent.yaml`:

```yaml
discord:
  allowedGuilds: ["935506093076017192"]
  denyChannels:  ["1234567890"]            # private/finance — never reachable
whatsapp:
  allowedJids:   ["120363424730853388@g.us"]
telegram:
  allowedChats:  ["-100123456789"]
```

**Default safe.** When no allow-list is set, the agent can only see/write
the *current* conversation — the channel/JID/chat that triggered this session.
A misbehaving agent (or a prompt-injected one) cannot suddenly spam other
groups.

**Cross-chat write override.** Even when scope allows reading multiple chats,
write tools refuse to send to chats other than the current one unless
`allowCrossChatWrite: true` is set.

**Audit log.** Every tool call writes one structured log line:
- Reads → `debug` level (cheap, high-volume).
- Writes → `info` level (auditable trail of what the agent sent on your behalf).

## Setup

### WhatsApp pairing

Pair via the dashboard: **Channels → ⚙️** on the WhatsApp card → QR or 8-digit
pairing code. The same Baileys session that handles routing also feeds the
MCP's history store — no second authentication.

The store starts populating automatically:
- On pair: ~14 days of history come in via `messaging-history.set`.
- During uptime: every received/sent message via `messages.upsert`.
- On demand: call `whatsapp_backfill` to pull deeper history.

Files live under `state/whatsapp-history/<sha1(jid)>.jsonl` (one file per chat).

### Channel registry

```sh
cp router/memory-channels.example.md ~/.claude/jarvis/memory/channels.md
$EDITOR ~/.claude/jarvis/memory/channels.md   # fill in your channels/JIDs
```

The MCP reloads on file change (mtime-cached) — no restart required.

## Failure modes (graceful)

- **WhatsApp not paired** → read returns empty (store has nothing); write
  returns `"WhatsApp socket unavailable"`. Pair via dashboard.
- **Backfill without anchor** → first send/receive a message in the chat so
  there's a reference point, then retry `whatsapp_backfill`.
- **Allow-list mismatch** → tool returns `"jid X is not in allowedJids"` —
  agent can call `channels_list_known` to discover what's permitted.
- **Cross-chat write attempted** → tool returns `"set allowCrossChatWrite:
  true in agent.yaml to enable"` — agent can route the user back to confirm.

In every case, the failure is structured (`isError: true` + reason) so the
agent recovers gracefully instead of crashing the session.
