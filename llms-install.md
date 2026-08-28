# QuantumProxies MCP Server — Automated Install Guide (for Cline)

This file tells an AI agent (e.g. Cline) exactly how to install and configure the
QuantumProxies MCP server without human back-and-forth. There are two transports.
**Prefer Option A (local npx stdio)** — it is the most portable and needs no
extra network config. Use Option B (remote HTTP) only if the user explicitly
wants the hosted endpoint.

The server exposes **25 tools** for live web access and proxy access: `scrape`,
`seo_audit`, `search`, `search_and_read`, `search_bulk`, `map`, `crawl`,
`batch`, `create_dataset`, the parser-preset tools, the collector tools,
`list_proxies`, `generate_proxies`, `proxy_locations`, and `whitelist_ip`.

## Prerequisites

1. **Node.js 18 or newer** must be available (`node --version`). `npx` ships with
   Node, so no separate install of the server package is required.
2. **A QuantumProxies API key.** Keys look like `qp_live_...` and are created at
   <https://app.quantumproxies.io/api-keys>. Running paid tools draws on your
   plan / prepaid balance.

### Getting the key (ask the user — never invent one)

- If the environment already has `QUANTUMPROXIES_API_KEY` set, reuse it and skip
  ahead.
- Otherwise, direct the user to <https://app.quantumproxies.io/api-keys> to
  create a key and have **them** provide it. Treat it as a secret.

## Option A — Local (npx stdio), recommended

Add this to the client's MCP servers config (Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "quantumproxies": {
      "command": "npx",
      "args": ["-y", "quantumproxies-mcp"],
      "env": { "QUANTUMPROXIES_API_KEY": "qp_live_YOUR_KEY" }
    }
  }
}
```

## Option B — Hosted remote (Streamable HTTP), zero install

For Cline (and any client that defaults to legacy SSE) set the transport type
explicitly to `streamableHttp`:

```json
{
  "mcpServers": {
    "quantumproxies": {
      "type": "streamableHttp",
      "url": "https://api.quantumproxies.io/mcp",
      "headers": { "Authorization": "Bearer qp_live_YOUR_KEY" }
    }
  }
}
```

The endpoint also accepts `X-Api-Key: qp_live_YOUR_KEY` instead of the
`Authorization` header, for clients that cannot set `Authorization`.

## Verify

`initialize` and `tools/list` answer without a key, so a populated tool list is
not proof the key works. Confirm the key with a cheap call — e.g. `list_proxies`
or `proxy_locations` — which needs a valid key and returns quickly.

## Notes

- Optional env `QUANTUMPROXIES_API_BASE` overrides the API base for
  staging/self-host; leave unset for production.
- `whitelist_ip` is the only tool marked destructive (removing an entry revokes a
  machine's proxy access) — confirm with the user before removing whitelist
  entries.
