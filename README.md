# QuantumProxies MCP Server

Connect [QuantumProxies](https://quantumproxies.io) to Claude, Cursor, and any
MCP client. Gives an AI agent live web access — scrape, search, map, and crawl —
through residential proxies with real-browser TLS fingerprints, so pages that
block ordinary bots come back clean. It also hands the agent raw proxy
endpoints of every type (residential, mobile, datacenter, ISP, IPv6) from your
active plans, ready to plug into any HTTP client.

It calls the **public** QuantumProxies Scraper API with your own `qp_live_` key,
so there are no internal secrets and you run it locally.

## Tools

| Tool | What it does |
|------|--------------|
| `scrape` | Scrape one URL → Markdown/HTML/text, including PDF/Office documents. Supports multi-format output, absolute link collection, JSON-LD metadata, structured CSS extraction, AI prompt/JSON-schema extraction, and `mode: summary`. |
| `unlock` | Web Unlocker: replay any HTTP request (method, headers, body) through a residential exit with a real browser TLS fingerprint, retry on a fresh IP, escalate a blocked GET to a real browser. Returns the raw response (status, headers, body); a still-blocked page comes back flagged (`blocked`, `blockClass`, `vendor`), never as a silent 200. Interactive captchas are not solved (`blockClass: "captcha"`). |
| `seo_audit` | Fetch a URL as a no-JS bot **and** fully rendered, return both SEO views + the diff (JS-only content, changed title/description, missing canonical) and bot-facing meta (robots, OG, JSON-LD). |
| `ai_visibility` | Can ChatGPT, Claude, Perplexity, Google AI Overview and Bing Copilot read **and cite** a page? On-page audit (24 AI crawlers in robots.txt, Content-Signal, a fetch as GPTBot, noindex/nosnippet/noai, text without JS, JSON-LD entities, answer-shaped copy, dates with age, author, sources) scored per pillar with blockers, evidence and fixes — plus an optional citation panel that asks the engines and reports cited / mentioned / rank, share of voice and who wins the questions you are absent from. |
| `search` | Structured Google/Bing/DuckDuckGo results. Set `render: true` for Google AI Overview, PAA, Knowledge Graph and other JS enrichments. |
| `search_and_read` | SERP → fetch top pages → numbered citation-ready sources and one token-bounded context string ready for an AI prompt. |
| `search_bulk` / `search_bulk_status` | Async multi-page pagination with merged organic results and page-one AI/zero-click enrichments. |
| `map` | Fast URL discovery (sitemaps + homepage links), no full crawl. Compact by default: up to `limit` URLs (100) plus site-wide `total` and per-section `summary`; `group_by: path` for the path tree. |
| `crawl` / `crawl_status` | Async BFS site crawl → Markdown per page; poll for progress. |
| `batch` / `batch_status` | Scrape many URLs asynchronously; `mode: summary` for metadata-only items. Incremental polling via `since` cursor; page content only with `include_content`. |
| `create_dataset` / `dataset_status` | Prompt-driven structured dataset collection with budget and row limits. |
| `list_collectors` / `run_collector` / `collector_run_status` | Ready-made Collectors: run a versioned scraper with a semantic input (keyword + location, place id, product id, domain…) instead of URLs — Google Maps places, place reviews, Google Jobs/News/Shopping, product offers, hotels, local business leads, site contacts, company profile. Priced per delivered row; async runs poll by `run_id`, rows exportable as CSV. |
| `list_proxies` | List your proxy services of every type — Residential Basic/Premium/Private, Mobile, Mobile V2, Datacenter, ISP, IPv6 — with bandwidth left, expiry and the `orderId` used to generate. |
| `generate_proxies` | Ready-to-use proxy strings (credentials included) from any active plan: geo targeting (country/state/city/ISP/ASN), rotating or sticky sessions, HTTP or SOCKS5, several output formats. |
| `proxy_locations` | Valid geo-targeting values per plan type: countries, states, cities, ASNs, or the full location tree with ISP codes. |
| `whitelist_ip` | Manage IP-auth whitelisting (add/list/remove) for plans that support it, including the Mobile V2 IP-auth proxy list. |
| `report` | Send feedback to the team from inside the agent: a bug (wrong/empty result, error, blocked page), a missing feature or collector, a question. Works **without an API key**. |

## Quick start

No install needed — `npx` fetches [quantumproxies-mcp](https://www.npmjs.com/package/quantumproxies-mcp) on demand (Node.js 18+).

**Claude Code** (one command):

```bash
claude mcp add quantumproxies \
  -e QUANTUMPROXIES_API_KEY=qp_live_your_key_here \
  -- npx -y quantumproxies-mcp
```

**Claude Desktop / Cursor / any MCP client** (`claude_desktop_config.json`, `.cursor/mcp.json`, or `.mcp.json`):

```json
{
  "mcpServers": {
    "quantumproxies": {
      "command": "npx",
      "args": ["-y", "quantumproxies-mcp"],
      "env": { "QUANTUMPROXIES_API_KEY": "qp_live_your_key_here" }
    }
  }
}
```

## Hosted endpoint (remote MCP)

The same server also runs as a hosted **Streamable HTTP** endpoint, for clients
that prefer a URL over a local package:

```
https://api.quantumproxies.io/mcp
```

### Connect with OAuth (no key to copy)

The endpoint supports the MCP authorization spec (OAuth 2.1). In a client that
supports it, add the URL above as a remote server and nothing else:

1. The client opens the QuantumProxies.io sign-in page.
2. You sign in (or create a free account) and click **Allow access**.
3. The client is connected. A key named `MCP · <client>` appears on the
   dashboard API keys page; delete it to disconnect the client.

Under the hood: authorization server metadata at
`https://app.quantumproxies.io/.well-known/oauth-authorization-server`,
protected resource metadata at
`https://api.quantumproxies.io/.well-known/oauth-protected-resource/mcp`,
dynamic client registration (RFC 7591) and Client ID Metadata Documents,
PKCE (S256) required, 1-hour access tokens with rotating refresh tokens, tokens
bound to this endpoint (RFC 8707). Usage is billed to your balance like any key.

### Or send your API key

Clients that take a bearer token can skip OAuth: the key travels per request in
the `Authorization` header (or `X-Api-Key`), nothing is stored server-side.

```bash
curl -X POST https://api.quantumproxies.io/mcp \
  -H "Authorization: Bearer qp_live_your_key_here" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request with neither a token nor a key gets `401` with a
`WWW-Authenticate` header pointing at the metadata above: that is what makes
OAuth-capable clients start the sign-in.

Self-hosting the endpoint is a second binary in this same package. With
`QUANTUMPROXIES_API_KEY` set it serves that one account to callers that send no
credential:

```bash
QUANTUMPROXIES_API_KEY=qp_live_… PORT=9310 npx -y quantumproxies-mcp-remote
```

## Run from source (development)

```bash
npm install
npm run build
```

Then point the client at the local build instead of npx:

```json
{
  "mcpServers": {
    "quantumproxies": {
      "command": "node",
      "args": ["/absolute/path/to/scraper-mcp/dist/index.js"],
      "env": {
        "QUANTUMPROXIES_API_KEY": "qp_live_your_key_here"
      }
    }
  }
}
```

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `QUANTUMPROXIES_API_KEY` | — | **Required.** Your `qp_live_` key. |
| `QUANTUMPROXIES_API_BASE` | `https://app.quantumproxies.io/api/v1` | Override for staging/self-host. |

Self-hosted remote endpoint only (`quantumproxies-mcp-remote`), optional:

| Var | Default | Notes |
|-----|---------|-------|
| `MCP_OAUTH_RESOURCE` | `https://api.quantumproxies.io/mcp` | This endpoint as an OAuth resource. |
| `MCP_OAUTH_ISSUER` | `https://app.quantumproxies.io` | Authorization server advertised in the resource metadata. |
| `MCP_OAUTH_INTROSPECT_URL` | `http://127.0.0.1:3090/api/v1/internal/oauth/introspect` | Where OAuth access tokens are checked. |
| `MCP_INTERNAL_TOKEN` | — | Secret for the introspection call. Unset = only API keys are accepted. |

## Example prompts

- "Scrape the pricing page at example.com and give me the plans and prices."
- "Search Google Shopping for 'nintendo switch oled' in the US and list the cheapest 5."
- "Map docs.example.com, then crawl only the /guides/ pages and summarize them."
- "List my proxy plans and generate 5 sticky US residential proxies as socks5 URLs."
- "Get me a rotating mobile proxy in Germany and whitelist my server IP 203.0.113.7."

## Privacy Policy

Full policy: <https://quantumproxies.io/privacy>

**What this server sends.** It runs on your machine and talks only to the public
QuantumProxies API at `https://app.quantumproxies.io/api/v1`, authenticated with
your own `qp_live_` key. Each call carries the arguments you (or your agent)
passed — the target URL or query, and any extraction prompt. Nothing else on your
machine is read or transmitted: the server has no filesystem, shell or clipboard
access.

**What we collect.** Account data you give us (name, email, billing details) and
a request log kept for billing, abuse prevention and support: target URL or
query, timestamp, response status, bytes transferred and the API key used. We do
**not** retain scraped page content beyond what is needed to return your result.

**Data you collect through the service.** You decide what public web data to
collect and **you are the controller of that data** — we process it on your
behalf only to fulfil your request. You are responsible for using the service
lawfully, for respecting the terms of the sites you access, and for any personal
data you collect through it.

**Sharing.** We do not sell personal data. We share it only with the processors
that run the service — payment providers, email delivery, hosting, CDN and
analytics — under contracts that bind them to protect it, and with the upstream
proxy networks that route your traffic (connection metadata only, never your
account details). We may disclose data where required by law.

**Retention.** Account data for as long as the account exists; request logs on a
rolling window for billing and abuse investigation. You can request deletion at
any time.

**Your key.** Claude Desktop stores it in the OS keychain and passes it to this
server as an environment variable. It is never written to the bundle and never
sent anywhere except the QuantumProxies API. Revoke or rotate it at
<https://app.quantumproxies.io/api-keys>.

**Contact.** <support@quantumproxies.io>
