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
| `seo_audit` | Fetch a URL as a no-JS bot **and** fully rendered, return both SEO views + the diff (JS-only content, changed title/description, missing canonical) and bot-facing meta (robots, OG, JSON-LD). |
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

## Example prompts

- "Scrape the pricing page at example.com and give me the plans and prices."
- "Search Google Shopping for 'nintendo switch oled' in the US and list the cheapest 5."
- "Map docs.example.com, then crawl only the /guides/ pages and summarize them."
- "List my proxy plans and generate 5 sticky US residential proxies as socks5 URLs."
- "Get me a rotating mobile proxy in Germany and whitelist my server IP 203.0.113.7."
