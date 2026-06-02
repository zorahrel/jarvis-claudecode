# mcp-hot-gateway

**An MCP server that mounts other MCP servers at runtime.** The agent calls
`gateway_mount` itself, mid-session — the child's tools appear instantly via
`notifications/tools/list_changed`. No session restart. No config-file edit.

> Most MCP gateways aggregate servers *statically*: you edit a config file or a
> DB, restart, and the tools show up. `mcp-hot-gateway` is **agent-driven and
> runtime-dynamic** — the model (or you) mounts and unmounts child servers
> while the session is live, and the client picks up the new tools immediately.

## The problem this solves

You're in a live session with Claude Code (or any MCP client). You realise you
need a tool from an MCP server that isn't connected. Normally you'd:

1. stop, edit `~/.claude.json` (or the client's config),
2. restart the session,
3. lose your context.

With `mcp-hot-gateway` mounted once at boot, you just say *"mount the GitHub MCP
server"* and its tools are live in the same turn — namespaced `github__*`.

## How it works

`mcp-hot-gateway` is a normal stdio MCP server, loaded once. It exposes three
always-on meta tools and proxies everything else:

| Tool | What it does |
|------|--------------|
| `gateway_list` | List mounted child servers and the tools each exposes. |
| `gateway_mount` | Connect a child MCP server, register its tools, emit `list_changed`. |
| `gateway_unmount` | Disconnect a child, drop its tools, emit `list_changed`. |

Child tools are exposed **namespaced** as `<child>__<tool>` (e.g.
`github__create_issue`), so two children with a tool of the same name never
collide. Calls are transparently proxied to the right child.

Mounted children are persisted to `gateway-config.json`, so they reconnect
automatically the next time the gateway boots.

### Supported child transports

- **stdio** — `{ transport: "stdio", command, args, env }`
- **streamable http** — `{ transport: "http", url, headers }`
- **sse** — `{ transport: "sse", url, headers }`

## Install

No install needed — run it straight from GitHub with `npx`:

```jsonc
// ~/.claude.json (or any MCP client config)
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:zorahrel/mcp-hot-gateway"]
    }
  }
}
```

Or clone and run locally:

```bash
git clone https://github.com/zorahrel/mcp-hot-gateway
cd mcp-hot-gateway && npm install
node index.mjs
```

## Usage

Once the gateway is connected, ask your agent to mount a server, or call the
tool directly:

```jsonc
// gateway_mount — stdio child
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "ghp_..." }
}
```

```jsonc
// gateway_mount — http child
{
  "name": "weather",
  "transport": "http",
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer ..." }
}
```

The new tools (`github__*`, `weather__*`) are available immediately. Call
`gateway_unmount { "name": "github" }` to remove them.

> **Client support note:** the live-update relies on the client honoring
> `notifications/tools/list_changed`. Most modern MCP clients (Claude Code,
> etc.) do. The persisted config means even clients that only read the tool
> list at startup will see all previously-mounted children on the next launch.

## Configuration

Both are optional environment variables:

| Env var | Default | Purpose |
|---------|---------|---------|
| `MCP_GATEWAY_CONFIG` | `./gateway-config.json` | Where mounted children are persisted. |
| `MCP_GATEWAY_REGISTRY` | *(off)* | If set to a writable path, also writes a flat `{ server → tools }` snapshot JSON — handy for an external dashboard to read. |

## License

MIT © Attilio Cianci
