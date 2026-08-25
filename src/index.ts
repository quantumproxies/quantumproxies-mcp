#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * QuantumProxies MCP server.
 *
 * Exposes the public Scraper API (scrape / search / map / crawl / batch) as MCP
 * tools so an agent in Claude, Cursor, or any MCP client can pull live web data
 * through QuantumProxies' residential pool with real-browser TLS fingerprints.
 *
 * It talks to the PUBLIC API with the caller's own qp_live_ key — no internal
 * secrets here — so it ships as a standalone package a customer runs locally.
 */

const API_BASE = (process.env.QUANTUMPROXIES_API_BASE || "https://app.quantumproxies.io/api/v1").replace(
  /\/+$/,
  ""
);
const API_KEY = process.env.QUANTUMPROXIES_API_KEY || "";

if (!API_KEY) {
  // Fail loudly on stderr (stdout is the MCP transport and must stay clean).
  console.error(
    "QUANTUMPROXIES_API_KEY is not set. Get a key at https://quantumproxies.io and set it in the MCP server env."
  );
  process.exit(1);
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Turn a transport-level failure into something the caller can act on. Node's
 * fetch throws a bare `TypeError: fetch failed` and hides the real reason in
 * `cause`, so an unreachable API (the usual case: a local dev server that isn't
 * running) reaches the agent as two useless words. Name the target and the
 * cause instead — every minute spent guessing at "fetch failed" is a wasted run.
 */
function transportError(err: unknown, url: string): Error {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code;
  const detail = code ?? cause?.message ?? (err as Error)?.message ?? String(err);
  let hint = "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET")
    hint = ` — nothing is listening there. Is the API up? (QUANTUMPROXIES_API_BASE=${API_BASE})`;
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    hint = ` — host does not resolve. Check QUANTUMPROXIES_API_BASE=${API_BASE}`;
  else if ((err as Error)?.name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT")
    hint = " — request timed out after 90s.";
  else if (code === "CERT_HAS_EXPIRED" || code?.startsWith?.("ERR_TLS"))
    hint = " — TLS handshake failed.";
  return new Error(`Cannot reach the QuantumProxies API at ${url} (${detail})${hint}`);
}

async function callApi(path: string, body: unknown, method: "POST" | "GET" | "DELETE" = "POST"): Promise<ApiResult> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw transportError(err, url);
  }
  let data: any = null;
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("json")) {
    // Text payloads (e.g. collector runs exported as CSV) are passed through verbatim.
    const text = await res.text().catch(() => "");
    data = res.ok ? { payload: text } : { message: text || `Non-JSON response (HTTP ${res.status})` };
    return { ok: res.ok, status: res.status, data };
  }
  try {
    data = await res.json();
  } catch {
    data = { message: `Non-JSON response (HTTP ${res.status})` };
  }
  return { ok: res.ok, status: res.status, data };
}

/** Unwrap the API envelope { message, payload } and format for the model. */
function toContent(result: ApiResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (!result.ok) {
    const msg = result.data?.message || result.data?.error || `Request failed (HTTP ${result.status})`;
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
  const payload = result.data?.payload ?? result.data;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

// Keep in sync with package.json "version" (npm version does NOT touch this file).
const server = new McpServer({ name: "quantumproxies", version: "0.8.1" });

// ── scrape (extract) ────────────────────────────────────────────────────────
server.tool(
  "scrape",
  "Scrape a single web page through a residential proxy and return it as clean Markdown (or HTML/text). Uses a real Chrome TLS fingerprint by default and only spins up a headless browser if the page is bot-challenged. Optionally run structured extraction (CSS selectors) or AI extraction (natural-language prompt). Markdown keeps the complete page by default (content_mode 'smart': everything except nav/footer/cookie chrome, with GFM tables and absolutized links); to inspect a page's raw no-JS/SEO fallback use format 'html'.",
  {
    url: z
      .string()
      .url()
      .optional()
      .describe("The page URL to scrape (optional only when you pass `html` to convert)"),
    format: z.enum(["markdown", "html", "text"]).optional().describe("Output format (default markdown)"),
    formats: z
      .array(z.enum(["markdown", "html", "text"]))
      .max(3)
      .optional()
      .describe("Additional formats to return together in payload.formats, e.g. ['markdown','text']"),
    include_links: z
      .boolean()
      .optional()
      .describe("Return all de-duplicated absolute page links in payload.links"),
    content_mode: z
      .enum(["smart", "article", "full"])
      .optional()
      .describe(
        "smart (default): whole page minus nav/footer/cookie chrome. article: Readability main article only (news/blogs). full: entire body as-is."
      ),
    engine: z
      .enum(["auto", "tls", "fetch", "render"])
      .optional()
      .describe(
        "auto (default): TLS tier, escalate to browser on block. tls: never escalate — exactly what a pure HTTP bot (no JS) sees, right for SEO checks. render: force browser."
      ),
    render: z.boolean().optional().describe("Force the headless browser (JS execution)"),
    mode: z
      .enum(["summary"])
      .optional()
      .describe(
        "summary: return only metadata (title, description, canonical, contentLength, status, engine, bytes) with no page content — use this when auditing pages instead of reading them"
      ),
    country: z.string().length(2).optional().describe("ISO country code for the proxy exit, e.g. 'us'"),
    ai_prompt: z
      .string()
      .optional()
      .describe("Natural-language instruction — the LLM turns the page into structured JSON"),
    ai_schema: z
      .record(z.any())
      .optional()
      .describe("JSON Schema for deterministic AI extraction; returned under payload.ai.data"),
    extract: z
      .record(z.any())
      .optional()
      .describe('Structured-extraction schema: { field: "css selector" | { selector, attr, all, fns } }. `fns` is a transform pipeline run on the value — e.g. { "price": { "selector": ".price", "fns": ["amount_from_string"] } } returns a number, not text. Functions: amount_from_string, amount_range_from_string, convert_to_float/int/str, trim, lower, upper, {regex_search|regex_find_all: "pat"}, {replace:{from,to}}, {join:","}, {select_nth:0}, length, unique, max, min, average, product.'),
    app_state: z
      .union([z.boolean(), z.enum(["auto", "raw"])])
      .optional()
      .describe(
        "Mine the page's own hydration state (Next.js __NEXT_DATA__, Nuxt, embedded JSON islands) into payload.metadata.appState. This is where SPAs keep the real data — prices behind a picker, stock, download counts, listings — even when the DOM shows only a shell, so it often answers the question without a browser render. true/'auto': pruned to the informative parts (recommended). 'raw': the complete blobs, up to 512KB."
      ),
    parser: z
      .object({
        include: z.array(z.string()).max(25).optional(),
        exclude: z.array(z.string()).max(25).optional(),
        keep: z.array(z.string()).max(25).optional(),
      })
      .optional()
      .describe(
        "Your own parsing rules, as CSS selector lists — use these when you know the page and don't want to rely on heuristics. include: keep ONLY these subtrees (targeted extraction, e.g. ['article.post']). exclude: delete site-specific chrome we kept. keep: protect a section (sidebar, dialog, form) that smart mode would strip."
      ),
    reveal_hidden: z
      .boolean()
      .optional()
      .describe(
        "Render tier only: before capturing, open <details>/accordions and click through every tab, appending each revealed panel to the page. Use it for tabbed code samples or spec accordions where a plain render captures only the visible variant."
      ),
    xhr: z
      .boolean()
      .optional()
      .describe(
        "Record the page's XHR/fetch traffic (URL, method, status, response body) into payload.xhr. Forces a browser render. An SPA's own JSON API is usually far cleaner than its DOM — use this to DISCOVER the API, then fetch_resource to return it directly."
      ),
    fetch_resource: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Regex matched against the page's network requests: the first matching response's BODY becomes the result instead of the page HTML (e.g. '/api/products' to get an SPA's JSON directly). Forces a render. Fails with 504 if nothing matches."
      ),
    preset_id: z
      .string()
      .optional()
      .describe(
        "Run a stored parser preset (see save_parser_preset) instead of passing `extract` selectors. Results land in payload.data exactly the same way, and the run is scored so the preset can detect decay and self-heal."
      ),
    actions: z
      .array(z.record(z.any()))
      .max(20)
      .optional()
      .describe(
        "Ordered browser interactions before capture (forces a render). Each is one object: {\"click\":\"#sel\"}, {\"clickText\":\"Accept\"} (click by visible text — dismiss a consent wall without knowing its CSS), {\"type\":{\"selector\":\"#q\",\"text\":\"shoes\"}}, {\"scroll\":\"bottom\"}, {\"wait\":1000}, {\"waitForSelector\":\".results\"}. Add \"optional\":true to skip a miss, or \"timeoutMs\":N to bound one action."
      ),
    frontmatter: z
      .boolean()
      .optional()
      .describe(
        "Prepend YAML front-matter (title, url, canonical, description, author, date) so the markdown is self-contained for RAG/Obsidian pipelines"
      ),
    links_mode: z
      .enum(["inline", "footnote", "strip"])
      .optional()
      .describe(
        "Link rendering. inline (default): [text](url). footnote: URLs moved to a numbered reference list at the end. strip: keep only the link text — cuts 30-48% of the tokens on link-dense pages when you only need the prose."
      ),
    toc: z.boolean().optional().describe("Prepend a table of contents built from the page headings"),
    max_tokens: z
      .number()
      .int()
      .min(200)
      .max(2_000_000)
      .optional()
      .describe(
        "Cap the markdown at ~this many tokens, cutting at a section boundary (never inside a table or code block) and noting how much was omitted"
      ),
    query: z
      .string()
      .max(512)
      .optional()
      .describe(
        "What you are looking for on the page. Keeps only the relevant sections (BM25 scoring over blocks, headings preserved) — the way to read one fact off a huge page without spending its whole token budget."
      ),
    highlights: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("With `query`: also return the N most relevant passages in payload.highlights"),
    chunk: z
      .object({
        by: z.enum(["heading", "sentence", "tokens"]).optional(),
        size: z.number().int().min(1).max(100_000).optional(),
        overlap: z.number().int().min(0).max(100_000).optional(),
      })
      .optional()
      .describe(
        "Segment the output into payload.chunks[] for RAG/vector-DB ingestion — each chunk carries its heading path and token count. Fences and tables are never split."
      ),
    images_mode: z
      .enum(["inline", "alt", "strip"])
      .optional()
      .describe("inline (default) keeps ![alt](url); 'alt' keeps only alt text; 'strip' removes images"),
    summary_sections: z
      .boolean()
      .optional()
      .describe("Append 'Links on this page' / 'Images on this page' sections — handy when deciding the next hop"),
    html: z
      .string()
      .optional()
      .describe(
        "Convert HTML you already have instead of fetching: no proxy bandwidth is used, and the full parser pipeline still applies. Pass `url` too if you want relative links absolutized."
      ),
    content_modes: z
      .array(z.enum(["smart", "article", "full"]))
      .max(3)
      .optional()
      .describe("Return several content scopes from ONE fetch under payload.contents (e.g. compare smart vs full)"),
    cookies: z
      .record(z.string())
      .optional()
      .describe("Cookies to send as name→value — the simple way to scrape behind a login"),
  },
  async (args) => {
    // fetch_resource is exposed as a flat string for ergonomics; the API takes
    // it as an ordered action, which must come last so nothing runs after the
    // result has been decided.
    const { fetch_resource, preset_id, ...rest } = args as Record<string, unknown> & {
      fetch_resource?: string;
      preset_id?: string;
    };
    if (preset_id) (rest as Record<string, unknown>).presetId = preset_id;
    const body = fetch_resource
      ? {
          ...rest,
          actions: [
            ...(Array.isArray(rest.actions) ? rest.actions : []),
            { fetchResource: { pattern: fetch_resource } },
          ],
        }
      : rest;
    return toContent(await callApi("/scraper/extract", body));
  }
);

// ── generate_parser ─────────────────────────────────────────────────────────
server.tool(
  "generate_parser",
  "Look at a page ONCE with an LLM and get back CSS selectors that extract the fields you asked for. Pass the returned `parser` as the `extract` argument on every later scrape of that same layout and no AI runs again — it becomes a plain, free, deterministic extraction. Use this instead of ai_prompt whenever you will scrape more than a couple of pages of the same shape. Every selector is run against the page before being returned, so `report`/`coverage` tell you which fields are actually reliable.",
  {
    url: z.string().url().optional().describe("The page to learn the layout from"),
    html: z
      .string()
      .optional()
      .describe("Markup you already have, instead of fetching a URL (no proxy bandwidth used)"),
    fields: z
      .record(z.string())
      .optional()
      .describe(
        'What to extract, as { field_name: "plain-English description" } — e.g. { "price": "the product price", "specs": "every spec bullet, as a list" }. Max 25.'
      ),
    prompt: z
      .string()
      .optional()
      .describe("Free-text alternative to `fields` — the model picks and names the fields itself"),
    render: z
      .boolean()
      .optional()
      .describe("Learn from the browser-rendered DOM instead of the raw HTML (needed for SPA pages)"),
    country: z.string().length(2).optional().describe("ISO country code for the proxy exit"),
  },
  async (args) => toContent(await callApi("/scraper/parser/generate", args))
);

// ── parser presets (save / list / stats / heal) ─────────────────────────────
server.tool(
  "save_parser_preset",
  "Store a generated parser under a name so it can be reused by id. Scrape later with scrape's `preset_id` instead of repeating the selectors, and every run is scored per field — when the recent success rate decays (the site redesigned), the preset regenerates itself from `source_url` and bumps a version. Give it a source_url whenever you can: without one it can never self-heal.",
  {
    name: z.string().max(120).describe("A name you'll recognise, e.g. 'amazon product page'"),
    parser: z
      .record(z.any())
      .describe("The parser to store — normally the `parser` object returned by generate_parser"),
    source_url: z
      .string()
      .url()
      .optional()
      .describe("Page to relearn from when the parser decays — required for self-healing"),
    fields: z
      .record(z.string())
      .optional()
      .describe("The original field descriptions, so a self-heal regenerates the same shape"),
    render: z.boolean().optional().describe("The page needs a browser render to show its content"),
    auto_heal: z.boolean().optional().describe("Regenerate automatically on decay (default true when source_url is set)"),
  },
  async ({ name, parser, source_url, fields, render, auto_heal }) =>
    toContent(
      await callApi("/scraper/parser/presets", {
        name,
        parser,
        sourceUrl: source_url,
        fields,
        render,
        autoHeal: auto_heal,
      })
    )
);

server.tool(
  "list_parser_presets",
  "List your stored parser presets with their version, health stats and changelog.",
  {},
  async () => toContent(await callApi("/scraper/parser/presets", null, "GET"))
);

server.tool(
  "parser_preset_stats",
  "How well a stored parser is still working: success rate per field, mean coverage over the recent runs, and whether it now counts as decayed (i.e. the site probably changed).",
  { preset_id: z.string().describe("The preset id returned by save_parser_preset") },
  async ({ preset_id }) =>
    toContent(await callApi(`/scraper/parser/presets/${encodeURIComponent(preset_id)}/stats`, null, "GET"))
);

server.tool(
  "heal_parser_preset",
  "Regenerate a preset's selectors now (the manual trigger for the automatic repair). Refetches the source page and adopts new selectors ONLY if they extract more than the current ones — a heal that finds nothing better leaves the preset untouched and is not billed.",
  {
    preset_id: z.string().describe("The preset id"),
    force: z.boolean().optional().describe("Bypass the cooldown between heals"),
  },
  async ({ preset_id, force }) =>
    toContent(await callApi(`/scraper/parser/presets/${encodeURIComponent(preset_id)}/heal`, { force }))
);

// ── seo_audit ───────────────────────────────────────────────────────────────
server.tool(
  "seo_audit",
  "Audit a URL's SEO in one call: fetches it twice — as a pure HTTP bot (no JS) and fully rendered — and returns both views (title, description, canonical, h1, word count) plus the diff (JS-only content, changed title/description, canonical missing without JS) and bot-facing meta (robots, Open Graph, JSON-LD types). Use this instead of scraping manually when checking how a page indexes.",
  {
    url: z.string().url().describe("The page URL to audit"),
    country: z.string().length(2).optional().describe("ISO country code for the proxy exit, e.g. 'us'"),
    no_render: z
      .boolean()
      .optional()
      .describe("Skip the rendered pass (cheaper — returns the no-JS view only, no diff)"),
  },
  async (args) => toContent(await callApi("/scraper/seo-audit", args))
);

// ── search (serp) ───────────────────────────────────────────────────────────
server.tool(
  "search",
  "Run structured Google, Bing or DuckDuckGo searches through a residential proxy. Bing supports web, shopping, images, news, videos, places/maps and autocomplete over HTTP, including Copilot AI answers and citations when Bing returns them. Google web search also parses rich blocks directly from its HTTP response.",
  {
    query: z
      .string()
      .optional()
      .describe("The search query (optional for place_details/product/flights/lens/reviews, which are ID/URL-addressed)"),
    engine: z.enum(["google", "bing", "duckduckgo"]).optional().describe("Search engine (default google)"),
    search_type: z
      .enum([
        "search", "shopping", "images", "news", "places", "maps", "videos", "scholar", "jobs", "autocomplete",
        "place_details", "hotels", "flights", "events", "product", "lens", "reviews", "trends",
      ])
      .optional()
      .describe(
        "Vertical (default search). Bing supports shopping/images/news/videos/places/maps/autocomplete. Google additionally supports scholar/jobs/place_details/hotels/flights/events/product/lens/reviews; maps accepts gps_coordinates, place_details uses place_id, and reviews uses data_id."
      ),
    country: z.string().length(2).optional().describe("ISO country code, e.g. 'us'"),
    lang: z.string().max(10).optional().describe("Search UI language, e.g. 'en' or 'it'"),
    render: z
      .boolean()
      .optional()
      .describe("Force browser rendering where supported; Google/Bing web search rich blocks are parsed over HTTP"),
    device: z.enum(["desktop", "mobile"]).optional().describe("SERP device shape (default desktop)"),
    page: z.number().int().min(1).optional().describe("Result page, 1-based (default 1). The response's pagination.available_pages lists which pages exist; use search_bulk to fetch many pages at once."),
    start: z.number().int().min(0).optional().describe("Result offset alias (0, 10, 20…)"),
    num: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "How many organic results to aim for (default 10, max 100). Google serves ~10 per page, so a larger num is satisfied by fetching consecutive pages and merging them — it is NOT ignored. `search_metadata.search_url` is necessarily the first page's URL and therefore shows num=<page size>; `search_metadata.paging` reports what was actually requested, the page size, and how many pages were fetched. Getting fewer results than requested means Google ran out, not that num was dropped. Use `page` to address one specific page, or search_bulk for many queries."
      ),
    location: z
      .string()
      .optional()
      .describe("Search from this location, e.g. 'Milan, Italy' (encoded to Google's uule server-side)"),
    timeframe: z
      .string()
      .optional()
      .describe(
        "Trends only: Google timeframe token — 'today 12-m' (default), 'now 7-d', or an explicit 'YYYY-MM-DD YYYY-MM-DD' range"
      ),
    uule: z
      .string()
      .optional()
      .describe("Geo token: encoded uule, or raw coordinates 'lat,lon' / 'lat,lon,radius_m' (encoded server-side)"),
    safe: z.enum(["active", "off"]).optional().describe("Google SafeSearch setting"),
    nfpr: z.boolean().optional().describe("Disable Google spelling correction"),
    wait_for: z
      .string()
      .max(512)
      .optional()
      .describe("Rendered path: wait for this CSS selector before parsing late panels"),
    browser: z
      .enum(["chrome", "firefox", "safari"])
      .optional()
      .describe("TLS/browser identity for the fetch path"),
    google_params: z
      .record(z.union([z.string(), z.number()]))
      .optional()
      .describe("Additional Google query parameters not modeled above"),
    place_id: z.string().optional().describe("Google Maps place id (from maps/places results) for place_details"),
    data_id: z
      .string()
      .optional()
      .describe("Maps data id, hex fid '0x…:0x…' (from maps/place_details results) — required for reviews"),
    product_id: z.string().optional().describe("Google Shopping product id for product details"),
    departure_id: z.string().optional().describe("Flights: departure airport IATA code, e.g. 'JFK'"),
    arrival_id: z.string().optional().describe("Flights: arrival airport IATA code, e.g. 'LAX'"),
    outbound_date: z.string().optional().describe("Flights: outbound date YYYY-MM-DD"),
    return_date: z.string().optional().describe("Flights: return date YYYY-MM-DD (omit for one-way)"),
    check_in_date: z.string().optional().describe("Hotels: check-in date YYYY-MM-DD"),
    check_out_date: z.string().optional().describe("Hotels: check-out date YYYY-MM-DD"),
    adults: z.number().int().min(1).max(10).optional().describe("Hotels: number of adults"),
    children_ages: z
      .array(z.number().int().min(0).max(17))
      .optional()
      .describe("Hotels: children's ages, e.g. [5, 7]"),
    free_cancellation: z.boolean().optional().describe("Hotels: only offers with free cancellation"),
    accommodation_type: z
      .enum(["hotels", "vacation_rentals"])
      .optional()
      .describe("Hotels: property kind (default hotels)"),
    currency: z.string().length(3).optional().describe("Hotels/Flights: price currency, e.g. 'EUR'"),
    gps_coordinates: z
      .string()
      .optional()
      .describe("Maps: center the search on 'lat,lon' or 'lat,lon,zoom' (zoom 3-21)"),
    image_url: z.string().optional().describe("Lens: publicly reachable image URL to reverse-search"),
    exact_matches: z
      .boolean()
      .optional()
      .describe("Lens: return the exact-matches tab (pages using this exact image) instead of visual matches"),
    sort_by: z
      .enum(["relevance", "newest", "highest_rating", "lowest_rating"])
      .optional()
      .describe("Reviews: sort order (default relevance)"),
    filter: z.string().optional().describe("Reviews: only reviews whose text contains this keyword"),
    next_page_token: z
      .string()
      .optional()
      .describe("Reviews: continuation token from the previous response's serpapi_pagination"),
  },
  async (args) => toContent(await callApi("/scraper/serp", args))
);

// ── search_and_read (SERP → citation-ready AI context) ─────────────────────
server.tool(
  "search_and_read",
  "Search the live web, fetch the top organic pages as clean Markdown, and return citation-ready numbered sources plus one token-bounded `context` string ready for an AI prompt. Use this when the goal is answering/researching, and use `search` when raw SERP structure or a specialized vertical is needed.",
  {
    query: z.string().min(1).describe("The research/search query"),
    engine: z.enum(["google", "bing", "duckduckgo"]).optional().describe("Search engine (default google)"),
    country: z.string().length(2).optional().describe("ISO country code for search and proxy geo"),
    lang: z.string().max(10).optional().describe("Search UI language, e.g. 'en' or 'it'"),
    top_n: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Top organic pages to fetch (default 3, max 5)"),
    max_tokens: z
      .number()
      .int()
      .min(500)
      .max(50_000)
      .optional()
      .describe("Maximum estimated tokens in the assembled context (default 8000)"),
    fetch_content: z
      .boolean()
      .optional()
      .describe("False returns snippet-only context without fetching result pages"),
  },
  async (args) => toContent(await callApi("/ai/search", args))
);

// ── map (URL discovery) ─────────────────────────────────────────────────────
server.tool(
  "map",
  "Discover a site's URLs fast (robots.txt sitemaps + /sitemap.xml + homepage links) without a full crawl. Returns up to `limit` URLs (default 100) plus the site-wide `total` and a per-section `summary` (e.g. '/blog': 1988) so you see the site's shape without the full list. Narrow with `search` (substring filter — the primary way to find specific pages) or set group_by 'path' for the path tree with counts instead of URLs.",
  {
    url: z.string().url().describe("The site URL to map"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Max URLs returned (default 100). `total`/`summary` always cover the whole site."),
    search: z
      .string()
      .optional()
      .describe("Only return URLs containing this substring — use this to narrow before raising limit"),
    group_by: z
      .enum(["path"])
      .optional()
      .describe("path: return the path tree with per-prefix counts instead of the flat URL list"),
    includeSubdomains: z.boolean().optional().describe("Include subdomains of the seed host"),
  },
  async (args) => toContent(await callApi("/scraper/map", args))
);

// ── crawl (start + status) ──────────────────────────────────────────────────
server.tool(
  "crawl",
  "Start an asynchronous BFS crawl of a site from a seed URL, converting each page to Markdown. Returns a job id — poll with crawl_status.",
  {
    url: z.string().url().describe("Seed URL"),
    limit: z.number().int().min(1).max(500).optional().describe("Max pages (default 50)"),
    depth: z.number().int().min(0).max(10).optional().describe("Max link depth (default 3)"),
    content_mode: z
      .enum(["smart", "article", "full"])
      .optional()
      .describe("Per-page content scope: smart (default) | article | full"),
    include: z.array(z.string()).optional().describe("URL substrings/globs to include"),
    exclude: z.array(z.string()).optional().describe("URL substrings/globs to exclude"),
    country: z.string().length(2).optional().describe("ISO country code for the proxy exit"),
  },
  async (args) => toContent(await callApi("/scraper/crawl", args))
);

server.tool(
  "crawl_status",
  "Poll a crawl job for progress and the pages crawled so far. Polls are incremental: pass the previous response's `nextCursor` as `since` to receive only the pages crawled since your last poll. Pages omit their content by default — set include_content true only when you actually need the text (a large crawl's full content can be hundreds of KB).",
  {
    jobId: z.string().describe("The crawl job id returned by crawl"),
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Page cursor from the previous poll's `nextCursor` — returns only newer pages"),
    include_content: z
      .boolean()
      .optional()
      .describe("Include each page's full content (default false — metadata only)"),
  },
  async ({ jobId, since, include_content }) => {
    const query = new URLSearchParams();
    if (since !== undefined) query.set("since", String(since));
    // Default to light polls (content off) so a large crawl doesn't flood the
    // context; the caller asks for content explicitly when it wants the text.
    query.set("include_content", include_content ? "true" : "false");
    const qs = query.toString();
    return toContent(
      await callApi(`/scraper/crawl/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET")
    );
  }
);

// ── batch (start + status) ──────────────────────────────────────────────────
server.tool(
  "batch",
  "Scrape many URLs asynchronously with shared options. Returns a job id — poll with batch_status. For SEO/status audits over many pages set mode 'summary': items carry metadata only (title, description, canonical, contentLength) instead of full page content.",
  {
    urls: z.array(z.string().url()).min(1).max(5000).describe("URLs to scrape"),
    format: z.enum(["markdown", "html", "text"]).optional().describe("Output format (default markdown)"),
    content_mode: z
      .enum(["smart", "article", "full"])
      .optional()
      .describe("Per-URL content scope: smart (default) | article | full"),
    engine: z.enum(["auto", "tls", "fetch", "render"]).optional().describe("Fetch engine (default auto)"),
    mode: z
      .enum(["summary"])
      .optional()
      .describe("summary: per-URL metadata only, no page content — the light mode for audits"),
    country: z.string().length(2).optional().describe("ISO country code for the proxy exit"),
  },
  async (args) => toContent(await callApi("/scraper/batch", args))
);

server.tool(
  "batch_status",
  "Poll a batch job for progress and per-URL results. Polls are incremental: pass the previous response's `nextCursor` as `since` to receive only the items completed after your last poll. Items omit page content by default — set include_content true only when you actually need the text.",
  {
    jobId: z.string().describe("The batch job id returned by batch"),
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Item cursor from the previous poll's `nextCursor` — returns only newer items"),
    include_content: z
      .boolean()
      .optional()
      .describe("Include each item's full page content (default false — metadata only)"),
  },
  async ({ jobId, since, include_content }) => {
    const query = new URLSearchParams();
    if (since !== undefined) query.set("since", String(since));
    if (include_content) query.set("include_content", "true");
    const qs = query.toString();
    return toContent(
      await callApi(`/scraper/batch/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET")
    );
  }
);

// ── search_bulk (paginate one query across many pages, async) ────────────────
server.tool(
  "search_bulk",
  "Paginate ONE search query asynchronously and merge deduplicated organic results. Page-one AI Overview/PAA/Knowledge Graph/answer enrichments are retained; set render:true to request those Google JS blocks. Billed per page actually fetched, with unavailable pages refunded.",
  {
    query: z.string().min(1).describe("The search query to paginate"),
    engine: z.enum(["google", "bing", "duckduckgo"]).optional().describe("Search engine (default google)"),
    search_type: z
      .enum(["search", "news", "videos", "images", "shopping"])
      .optional()
      .describe("Vertical to paginate (default search)"),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Max pages to fetch (1-10, default 5). Stops early when Google has no more pages."),
    country: z.string().length(2).optional().describe("ISO country code, e.g. 'us'"),
    lang: z.string().max(10).optional().describe("UI language, e.g. 'en'"),
    render: z.boolean().optional().describe("Force rendering to capture page-one Google JS enrichments"),
    device: z.enum(["desktop", "mobile"]).optional().describe("SERP device shape"),
    location: z.string().max(256).optional().describe("Search location, e.g. 'Milan, Italy'"),
    uule: z.string().max(512).optional().describe("Encoded geo token or raw coordinates"),
    safe: z.enum(["active", "off"]).optional().describe("Google SafeSearch setting"),
    nfpr: z.boolean().optional().describe("Disable Google spelling correction"),
    wait_for: z.string().max(512).optional().describe("Rendered path CSS selector for late panels"),
    browser: z.enum(["chrome", "firefox", "safari"]).optional().describe("Fetch-path browser identity"),
    google_params: z
      .record(z.union([z.string(), z.number()]))
      .optional()
      .describe("Additional Google query parameters"),
    webhook: z.string().url().optional().describe("Public URL to POST the finished job to"),
  },
  async (args) => toContent(await callApi("/scraper/serp/bulk", args))
);

server.tool(
  "search_bulk_status",
  "Poll a bulk search job for progress and merged organic results. Polls are incremental: pass the previous response's `nextCursor` as `since` to receive only the organic results gathered after your last poll.",
  {
    jobId: z.string().describe("The bulk search job id returned by search_bulk"),
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Organic cursor from the previous poll's `nextCursor` — returns only newer results"),
  },
  async ({ jobId, since }) => {
    const query = new URLSearchParams();
    if (since !== undefined) query.set("since", String(since));
    const qs = query.toString();
    return toContent(
      await callApi(`/scraper/serp/bulk/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET")
    );
  }
);

// ── dataset (Quantic AI: prompt → dataset) ──────────────────────────────────
server.tool(
  "create_dataset",
  "Build a structured dataset from a plain-language prompt. Quantic AI plans the search queries, searches Google/Bing/DuckDuckGo, maps the sites it finds and scrapes them into validated rows (CSV/JSON). Returns a job id — poll with dataset_status. Billed per delivered, validated record (email/phone fields cost extra, only when found); the run never exceeds limits.max_cost_usd, and the unspent budget is refunded.",
  {
    prompt: z
      .string()
      .describe("What dataset you want, in plain language (e.g. 'coffee roasters in Portland with email and phone')"),
    columns: z
      .array(
        z.object({
          name: z.string(),
          type: z
            .enum(["string", "number", "email", "phone", "url", "boolean", "deep"])
            .optional()
            .describe("email/phone/deep are premium fields, billed only when found"),
          description: z.string().optional(),
        })
      )
      .optional()
      .describe("Columns to extract; omit to let the planner infer them"),
    country: z.string().length(2).optional().describe("ISO country code for the proxy exit geo"),
    sources: z
      .object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })
      .optional()
      .describe("Domain allow/deny lists"),
    limits: z
      .object({
        max_rows: z.number().int().min(1).optional(),
        max_pages: z.number().int().min(1).optional(),
        max_cost_usd: z.number().min(0.05).optional().describe("Budget cap for the run (default 5)"),
      })
      .optional(),
    webhook: z.string().url().optional().describe("Public URL to POST the finished dataset to"),
  },
  async (args) => toContent(await callApi("/scraper/datasets", args))
);

server.tool(
  "dataset_status",
  "Poll a dataset job for progress, the collection trace (steps) and the rows so far. Polls are incremental: pass the previous response's `nextCursor` as `since` to receive only rows delivered after your last poll. Set mode 'summary' to omit rows and get only progress + steps (light poll). When status is completed, the response includes signed CSV/JSON download URLs.",
  {
    jobId: z.string().describe("The dataset job id returned by create_dataset"),
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Row cursor from the previous poll's `nextCursor` — returns only newer rows"),
    mode: z.enum(["summary"]).optional().describe("summary: progress + steps only, no rows"),
  },
  async ({ jobId, since, mode }) => {
    const query = new URLSearchParams();
    if (since !== undefined) query.set("since", String(since));
    if (mode) query.set("mode", mode);
    const qs = query.toString();
    return toContent(
      await callApi(`/scraper/datasets/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET")
    );
  }
);

// ── proxies (hand the agent raw proxy endpoints of every type) ──────────────
const PLAN_TYPES = [
  "residentialbasic",
  "residentialpremium",
  "resiprivate",
  "isp",
  "datacenter",
  "datacentertraffic",
  "ipv6",
  "mobile",
  "mobile_v2",
] as const;

server.tool(
  "list_proxies",
  "List the account's proxy services of every type — Residential Basic/Premium/Private, Mobile, Mobile V2, Datacenter (static or traffic-based), ISP, IPv6 — with plan type, bandwidth left, expiry, whitelisted IPs and the orderId to pass to generate_proxies. Call this first to see which proxy plans are available.",
  {
    active: z
      .boolean()
      .optional()
      .describe("true: only non-expired services (recommended). false: only expired. Omit for all."),
    planType: z.enum(PLAN_TYPES).optional().describe("Only services of this plan type"),
    limit: z.number().int().min(1).max(100).optional().describe("Max services returned (default 50)"),
    offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  },
  async ({ active, planType, limit, offset }) => {
    const query = new URLSearchParams();
    if (active !== undefined) query.set("active", String(active));
    if (planType) query.set("planType", planType);
    if (limit !== undefined) query.set("limit", String(limit));
    if (offset !== undefined) query.set("offset", String(offset));
    const qs = query.toString();
    return toContent(await callApi(`/public/proxies${qs ? `?${qs}` : ""}`, null, "GET"));
  }
);

server.tool(
  "generate_proxies",
  "Generate ready-to-use proxy endpoint strings (credentials included) from one of the account's active proxy services — any type: residential, mobile, datacenter, ISP, IPv6. Supports geo targeting (country/state/city, ISP or ASN where the plan allows it), rotating or sticky sessions, HTTP or SOCKS5, and several output formats. Use list_proxies first to get the orderId, and proxy_locations for valid targeting codes. The returned strings plug straight into any HTTP client, e.g. curl -x.",
  {
    orderId: z.string().describe("The proxy service's orderId (from list_proxies)"),
    protocol: z.enum(["http", "socks5"]).optional().describe("Proxy protocol (default http)"),
    format: z
      .enum(["user:pass@host:port", "host:port:user:pass", "http://user:pass@host:port", "socks5://user:pass@host:port"])
      .optional()
      .describe("Output string format (default user:pass@host:port)"),
    quantity: z.number().int().min(1).max(10000).optional().describe("Number of proxy strings (default 10)"),
    country: z.string().max(10).optional().describe("Country code for geo targeting, lowercase, e.g. 'us'"),
    state: z
      .string()
      .optional()
      .describe("State/region (Residential Premium & Mobile V2: use the slug from proxy_locations; 'all' for any)"),
    city: z.string().optional().describe("City (slug from proxy_locations where applicable; 'all' for any)"),
    rotation: z
      .enum(["rotating", "sticky", "static"])
      .optional()
      .describe("rotating (default): new IP per request. sticky: keep the IP for sessionTime. static: IPv6 only, fixed session with no TTL."),
    sessionTime: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .optional()
      .describe("Sticky session duration in minutes (default 10; Residential Basic/Datacenter minimum 3)"),
    isp: z
      .string()
      .optional()
      .describe("ISP code for Residential Premium / Mobile V2 targeting (from proxy_locations tree, e.g. 'tmobile')"),
    asn: z.string().optional().describe("ASN for Residential/Datacenter Basic targeting, e.g. 'AS12345'"),
    strict: z
      .boolean()
      .optional()
      .describe("Residential/Datacenter Basic: true allows fallback to nearby locations when the exact target has no IPs"),
    filter: z
      .enum(["speed", "speed-quality", "quality"])
      .optional()
      .describe("Residential Premium / Mobile V2 pool filter (omit for the full pool)"),
    ip: z
      .string()
      .optional()
      .describe("Mobile V2 only: a whitelisted IP (see whitelist_ip) to fetch the IP-auth proxy list instead of user:pass proxies"),
    gateway: z.enum(["ww", "us", "eu", "as"]).optional().describe("Mobile V2 region gateway (default ww)"),
  },
  async (args) => toContent(await callApi("/public/proxies/generate", args))
);

server.tool(
  "proxy_locations",
  "Discover valid geo-targeting values for a proxy plan type before calling generate_proxies: countries, states, cities, ASNs, or the full location tree (countries → regions → cities → ISPs). Use level 'tree' for Residential Premium / Mobile V2 slugs and ISP codes, or for the static datacenter gateway list; note the tree can be large.",
  {
    planType: z.enum(PLAN_TYPES).describe("The plan type to look up (same value as list_proxies planType)"),
    level: z
      .enum(["countries", "states", "cities", "asns", "tree"])
      .optional()
      .describe(
        "countries (default) | states (needs country) | cities (needs country) | asns | tree (full location tree: residentialpremium, mobile/mobile_v2, datacenter)"
      ),
    country: z.string().max(10).optional().describe("Country code, required for states/cities, optional filter for asns"),
    state: z.string().optional().describe("Cities only: filter by state"),
  },
  async ({ planType, level, country, state }) => {
    const lvl = level || "countries";
    if (lvl === "tree") {
      const path =
        planType === "residentialpremium" || planType === "resiprivate"
          ? "/public/generator/residential-premium/targeting-options"
          : planType === "mobile" || planType === "mobile_v2"
            ? "/public/generator/mobile/targeting-options"
            : "/public/generator/datacenter/targeting-options";
      return toContent(await callApi(path, null, "GET"));
    }
    const query = new URLSearchParams({ planType });
    if (country) query.set("country", country);
    if (state) query.set("state", state);
    return toContent(await callApi(`/public/geo/${lvl === "cities" ? "cities" : lvl}?${query.toString()}`, null, "GET"));
  }
);

server.tool(
  "whitelist_ip",
  "Manage IP-auth whitelisting on a proxy service (Residential Basic, Datacenter, ISP, IPv6, Mobile): add or remove an IP, or list the current entries. A whitelisted machine uses the proxies without username/password — required for the Mobile V2 IP-auth proxy list. Residential Premium/Private use user:pass auth and don't need this.",
  {
    action: z.enum(["add", "list", "remove"]).describe("What to do with the order's whitelist"),
    orderId: z.string().describe("The proxy service's orderId (from list_proxies)"),
    ip: z.string().optional().describe("The IP to add/remove (required for add and remove)"),
    ports_count: z.number().int().min(1).max(1000).optional().describe("Mobile add: number of ports to allocate"),
    protocol: z.enum(["HTTP", "SOCKS5"]).optional().describe("Mobile add: protocol for the allocated ports"),
    country: z.string().max(10).optional().describe("Mobile add: geo targeting for the ports, e.g. 'us'"),
    region: z.string().optional().describe("Mobile add: region slug"),
    city: z.string().optional().describe("Mobile add: city slug"),
    isp: z.string().optional().describe("Mobile add: ISP code, e.g. 'tmobile'"),
    sticky: z.boolean().optional().describe("Mobile add: keep the same IP per port"),
    ttl: z.number().int().min(1).optional().describe("Mobile add: sticky session TTL in seconds"),
  },
  async ({ action, orderId, ip, ...mobileOpts }) => {
    if (action === "list") {
      return toContent(await callApi(`/public/proxies/whitelist-ip?orderId=${encodeURIComponent(orderId)}`, null, "GET"));
    }
    if (!ip) {
      return {
        content: [{ type: "text" as const, text: "Error: `ip` is required for add/remove" }],
        isError: true,
      };
    }
    if (action === "remove") {
      return toContent(await callApi("/public/proxies/whitelist-ip", { orderId, ip }, "DELETE"));
    }
    return toContent(await callApi("/public/proxies/whitelist-ip", { orderId, ip, ...mobileOpts }, "POST"));
  }
);

// ── Collectors (ready-made scrapers: semantic input, results priced per row) ─
server.tool(
  "list_collectors",
  "List the ready-made Collectors: paid, versioned scrapers you run with a semantic input (keyword + location, place id, product id, domain…) instead of URLs — e.g. web_search, search_images, search_videos, keyword_ideas, amazon_search, amazon_product, ebay_search, aliexpress_search, linkedin_jobs, indeed_jobs, reddit_posts, youtube_search, youtube_channel, instagram_profile, tiktok_profile, tiktok_video, linkedin_profile, linkedin_company, zillow_search, zillow_property, app_store_apps, app_store_reviews, google_play_apps, google_maps_places, place_reviews, google_jobs, google_news, google_shopping, product_offers, hotels, google_flights, google_events, google_trends, google_autocomplete, google_lens, youtube_video, ebay_product, flipkart_search, idealista_search, kleinanzeigen_search, autotrader_search, github_repos, hacker_news, coingecko_coins, wikipedia_articles, yahoo_finance, stackoverflow, steam, npm_packages, sec_filings, defillama, wayback_machine, clinical_trials, certificate_transparency, wikidata, nvd_cve, openfda, openalex, pypi_packages, exchange_rates, gleif_lei, docker_hub, crates_io, world_bank, openlibrary_books, arxiv_papers, weather_forecast, whois_domain, dns_records, itunes_search, local_business_leads, site_contacts, company_profile, business_directory. Returns each collector's slug, input/output schema, example input, price per delivered result and current health. Billing is pay-per-success: only delivered rows are charged.",
  {
    category: z.string().max(40).optional().describe("Optional category filter (e.g. 'local', 'ecommerce', 'jobs', 'news', 'travel', 'leads', 'finance', 'dev', 'gaming', 'osint', 'research', 'classifieds', 'knowledge')"),
  },
  async ({ category }) => {
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    return toContent(await callApi(`/scraper/collectors${qs}`, null, "GET"));
  }
);

server.tool(
  "run_collector",
  "Run a Collector by slug with a semantic input (see list_collectors for each collector's inputSchema and example). Short runs return the rows inline; long runs return 202 with a run_id + statusUrl — poll with collector_run_status. Results are billed per delivered row (never for failures). Set `async` true to force background execution.",
  {
    slug: z.string().min(1).describe("Collector slug from list_collectors, e.g. 'google_maps_places'"),
    input: z.record(z.unknown()).describe("Input fields matching the collector's inputSchema (e.g. { keyword: 'dentist', location: 'Austin, TX', max_results: 20 })"),
    async: z.boolean().optional().describe("Force background execution and return a run_id to poll"),
  },
  async ({ slug, input, async: asyncRun }) =>
    toContent(await callApi(`/scraper/collectors/${encodeURIComponent(slug)}/run`, { ...input, ...(asyncRun ? { async: true } : {}) }))
);

server.tool(
  "collector_run_status",
  "Fetch a Collector run by run_id: status (queued|running|done|failed), result count, cost, partial flag and the result rows. Use after run_collector returned 202/async. Pass format 'csv' to get the rows as CSV text.",
  {
    run_id: z.string().min(1).describe("The run id returned by run_collector"),
    format: z.enum(["json", "csv"]).optional().describe("Return rows as JSON (default) or CSV text"),
  },
  async ({ run_id, format }) => {
    const qs = format === "csv" ? "?format=csv" : "";
    return toContent(await callApi(`/scraper/collectors/runs/${encodeURIComponent(run_id)}${qs}`, null, "GET"));
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Ready. Logs go to stderr so stdout stays a clean JSON-RPC channel.
  console.error(`QuantumProxies MCP server running (API base: ${API_BASE})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
