import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrumentServer } from "./analytics.js";
import { z } from "zod";

/**
 * QuantumProxies MCP server — shared core.
 *
 * Exposes the public Scraper API (scrape / search / map / crawl / batch) as MCP
 * tools so an agent in Claude, Cursor, or any MCP client can pull live web data
 * through QuantumProxies' residential pool with real-browser TLS fingerprints.
 *
 * It talks to the PUBLIC API with the caller's own key — no internal secrets —
 * so the same factory backs both the local stdio entry (index.ts) and the
 * remote Streamable HTTP entry (remote.ts), which builds one server per
 * request with the key taken from the request's Authorization header.
 */

/**
 * How the caller is expected to supply their key. It differs per transport, and
 * telling a hosted user to "set an environment variable" is useless advice —
 * they are connecting from a client and have no shell on this process.
 */
export type Transport = "stdio" | "http";

const REGISTER_URL = "https://app.quantumproxies.io/register";
/**
 * Every register link the server hands out says WHY it was shown: the signup
 * flow keeps utm_source as User.signupSource, so /admin/mcp can count how many
 * accounts the MCP itself brought in, and from which door (no key, trial used
 * up, tool outside the trial…). Same page, different label.
 */
function registerUrl(medium: "no_key" | "rejected_key" | "keyless"): string {
  return `${REGISTER_URL}?utm_source=mcp&utm_medium=${medium}`;
}
const KEYS_URL = "https://app.quantumproxies.io/api-keys";
const BALANCE_URL = "https://app.quantumproxies.io/balance";
/**
 * Informational price list (no checkout on it). The hosted endpoint is what the
 * ChatGPT plugin directory reviews, and its guidelines forbid linking a
 * transactional page or promoting upgrades from inside a plugin: they allow only
 * explaining that the account's balance does not cover a feature, with a link to
 * an informational page. So over HTTP the out-of-credit message points here
 * instead of the top-up page.
 */
const PRICING_URL = "https://quantumproxies.io/pricing/";
const UNLOCK_URL = "https://app.quantumproxies.io/unlock";

/**
 * Someone running a tool without a key is not a bug report — it is a developer
 * evaluating the product from inside their agent, and this string is the only
 * pitch we get to make. "Invalid key" tells them nothing and ends the trial
 * there; what converts is naming what they would get and handing them the two
 * links that unlock it. The agent relaying this to a human is the audience.
 *
 * Claims stay checkable: no $ figures and no exact counts, because both live in
 * the DB (SiteSetting `scraper_billing_config`, the collector catalog) while
 * this string ships pinned inside an npm package and would go stale silently.
 */
const PITCH =
  "With a key this server hands your agent live web data: any page as clean Markdown through " +
  "residential proxies with a real Chrome TLS fingerprint, Google/Bing/DuckDuckGo SERP, whole-site " +
  "crawl and map, AI extraction, and 70+ ready-made collectors (maps, jobs, marketplaces, e-commerce, " +
  "public registries). No proxy plumbing, no headless browser to keep alive. You pay per call, and " +
  "every account starts with a free monthly allowance — thousands of pages before it costs anything.";

export const MISSING_KEY_MESSAGE =
  "Nothing ran: this QuantumProxies MCP server has no API key yet.\n\n" +
  PITCH +
  "\n\nSet it up (about a minute, no credit card):\n" +
  "1. Create a free account:\n" +
  `   ${registerUrl("no_key")}\n` +
  "2. Create an API key and copy it:\n" +
  `   ${KEYS_URL}\n` +
  "3. Add it to this server's entry in your MCP config as the env var QUANTUMPROXIES_API_KEY, then restart the client.\n\n" +
  "Already made a key? It has to live in the MCP config: the client spawns this process, so a key exported in your shell never reaches it.";

const MISSING_KEY_MESSAGE_HTTP =
  "Nothing ran: this request carried no QuantumProxies API key.\n\n" +
  PITCH +
  "\n\nSet it up (about a minute, no credit card):\n" +
  "1. Create a free account:\n" +
  `   ${registerUrl("no_key")}\n` +
  "2. Create an API key and copy it:\n" +
  `   ${KEYS_URL}\n` +
  "3. Reconnect this connector and paste the key when the client asks — it travels as an " +
  "Authorization: Bearer <key> header (X-Api-Key works too).\n\n" +
  "Browsing the tool list needs no key; running a tool does.";

/**
 * The key was sent but the API turned it down. Same reasoning as above: the
 * upstream body is one flat sentence ("Invalid API key"), which leaves the user
 * guessing between four different causes. Name them, then give the one link
 * that fixes all four.
 */
function rejectedKeyMessage(apiMessage: string, transport: Transport): string {
  const head =
    `QuantumProxies did not accept this API key — the API answered: ${apiMessage}\n\n` +
    "Usually one of four things: the key was revoked or regenerated, only part of it was pasted, " +
    "it expired, or it belongs to another dashboard — QuantumProxies keys start with qp_live_.\n\n" +
    "A fresh key is one click and works immediately:\n" +
    `   ${KEYS_URL}`;
  // Hosted endpoint (reviewed as a ChatGPT plugin): no sign-up pitch in results.
  if (transport === "http") return head;
  return (
    head +
    "\n\nNo account yet? Signing up is free and every account starts with a free monthly allowance:\n" +
    `   ${registerUrl("rejected_key")}`
  );
}

/** Out of credit mid-run: say where to fix it instead of dead-ending the agent. */
function outOfCreditMessage(apiMessage: string, transport: Transport): string {
  if (transport === "http") {
    // Plugin-directory rule: explain why the call did not run and link an
    // informational page, never a top-up/checkout page or an upgrade pitch.
    return (
      `${apiMessage}\n\n` +
      "This call did not run because the account balance does not cover it. Prices per call and per result are listed at:\n" +
      `   ${PRICING_URL}`
    );
  }
  return (
    `${apiMessage}\n\n` +
    "Top up and the same call goes straight through — it is pay-as-you-go credit, no subscription, " +
    "and the free monthly allowance resets on its own:\n" +
    `   ${BALANCE_URL}`
  );
}

export function missingKeyMessage(transport: Transport): string {
  return transport === "http" ? MISSING_KEY_MESSAGE_HTTP : MISSING_KEY_MESSAGE;
}

// ── Keyless tier (hosted endpoint only) ─────────────────────────────────────
// Without a key the hosted endpoint relays tool calls to the API as keyless
// traffic (shared secret + visitor IP); the API serves them from a pool account
// under limits the admin tunes and answers account_required where an account is
// needed. These pieces do the selling: the instructions the model reads at
// initialize, a one-line reminder when the per-minute allowance is nearly gone,
// and an MCP prompt. No $ figures and no exact counts: they live in the DB.

const KEYLESS_REGISTER_URL = registerUrl("keyless");

const KEYLESS_UPGRADE =
  "A free account (about a minute, no card) removes the keyless cap and adds browser rendering and " +
  "screenshots, AI extraction, 70+ ready-made collectors, crawl and batch jobs, and a monthly free " +
  "allowance that resets on its own: " +
  KEYLESS_REGISTER_URL;

const KEYLESS_INSTRUCTIONS =
  "This connection has no QuantumProxies API key, so it runs on the KEYLESS tier: the basic tools only " +
  "(a page as clean Markdown over plain HTTP, search results, a site map), a small per-IP limit of " +
  "requests per minute, and no JavaScript rendering. " +
  "When the user's task needs rendering or screenshots, AI extraction, ready-made collectors, crawl or batch " +
  "jobs, or more throughput — or a call comes back with 'account_required' or a keyless limit — tell them " +
  "plainly that a free QuantumProxies account unlocks it in about a minute with no credit card, and give " +
  "them this link: " +
  KEYLESS_REGISTER_URL +
  " Then ask them to paste the API key into this connector (Authorization: Bearer <key>). " +
  "Say it once, when it matters, not under every answer.";

const CREATE_ACCOUNT_PROMPT =
  "I am using the QuantumProxies MCP connector without an API key (keyless tier). In a few short " +
  "paragraphs, tell me concretely what I gain by creating a free account, then walk me through connecting it.\n\n" +
  "Facts to use, nothing else:\n" +
  "- Keyless tier: basic tools only (page to Markdown over plain HTTP, search results, site map), a small " +
  "per-IP limit per minute, no JavaScript rendering, no AI extraction, no collectors.\n" +
  "- Free account: a monthly free allowance that resets on its own, a higher per-minute limit, browser " +
  "rendering and screenshots, AI extraction, 70+ ready-made collectors (maps, jobs, marketplaces, e-commerce, " +
  "public registries), crawl and batch jobs, whole-site map. After the allowance you pay per successful call " +
  "only — no subscription, no credit card to start.\n" +
  "- Steps: 1) create the account at " +
  KEYLESS_REGISTER_URL +
  " 2) create an API key at " +
  KEYS_URL +
  " 3) paste it into this connector as the Authorization: Bearer <key> header (X-Api-Key works too) and reconnect.\n\n" +
  "End with the register link on its own line.";

export interface BuildOptions {
  /** API key; falls back to QUANTUMPROXIES_API_KEY. Empty = introspection only (tool calls answer 401). */
  apiKey?: string;
  /** API base; falls back to QUANTUMPROXIES_API_BASE. */
  apiBase?: string;
  /** Shapes the "no key" instructions. Defaults to stdio (the npm package). */
  transport?: Transport;
  /**
   * Chi sta chiamando, quando il transport lo sa già. Serve al transport HTTP,
   * che è stateless: ogni POST costruisce un server nuovo, quindi
   * `getClientVersion()` è popolato SOLO sulla richiesta che porta l'initialize
   * e resta vuoto su tutte le tools/call — che sono proprio quelle che toccano
   * l'API. remote.ts lo ripesca (corpo dell'initialize o token di sessione) e
   * lo passa di qui.
   */
  clientInfo?: { name?: string; version?: string } | null;
  /**
   * Keyless relay (hosted endpoint only): with no key and the shared secret
   * ANON_ACCESS_TOKEN, tool calls go to the API as keyless traffic. Without the
   * secret, introspection only and tool calls get the setup message.
   */
  anonToken?: string;
  /** The visitor's IP as the transport saw it — forwarded so the API limits per caller, not per relay. */
  clientIp?: string;
  /** How the hosted endpoint authenticated the caller: "oauth" signs the calls so /admin/mcp can count OAuth connections. */
  auth?: "oauth" | "key";
  /**
   * "chatgpt": the ChatGPT app's tool set (remote.ts picks it from the OAuth
   * client). unlock is limited to public GET/HEAD and the collectors that return data about individuals are not
   * offered. Anything else: the full server.
   */
  profile?: "chatgpt";
  /**
   * Expose only these tools (comma-separated names or presets, e.g. "web" or
   * "search,scrape"). Falls back to QUANTUMPROXIES_TOOLS. Meant for local models:
   * the full set of definitions is about 14K tokens, more than Ollama's default
   * 4K context. Unknown names are ignored; if nothing matches, every tool stays.
   */
  tools?: string;
}

/**
 * Come si firmano le chiamate all'API. Fino al 25/09/2026 non si firmavano
 * affatto: `fetch` mandava solo Authorization e Content-Type, quindi in
 * `ApiRequestLog` il traffico MCP arrivava come `node` o null, indistinguibile
 * da uno script qualsiasi — impossibile dire chi usasse l'MCP e da dove.
 * La versione la riallinea scripts/sync-version.mjs insieme a quella
 * dichiarata dall'McpServer; il nome lo brandifica quantic-mcp/sync-from-scraper-mcp.sh.
 */
const MCP_UA_BASE = "quantumproxies-mcp/0.11.4";
/** The version this build declares (kept in step with package.json by scripts/sync-version.mjs). */
export const MCP_VERSION = MCP_UA_BASE.split("/")[1] ?? "0.0.0";
/** QP | QD — which brand this build serves (the sync script rebrands the package name). */
export const BRAND_KEY: "QP" | "QD" = MCP_UA_BASE.startsWith("quanticdata") ? "QD" : "QP";

/** Header value sanitizer: il nome del client arriva da fuori e non deve poter iniettare header. */
function uaSafe(s: string, max = 40): string {
  return String(s).replace(/[^A-Za-z0-9._ /-]/g, "").trim().slice(0, max);
}

/**
 * Collectors not offered in the ChatGPT app: they return profiles or contact
 * details of individuals (people, doctors, lead lists), which ChatGPT apps may
 * not collect. They stay available everywhere else.
 */
const CHATGPT_HIDDEN_COLLECTORS = new Set([
  "linkedin_profile",
  "instagram_profile",
  "tiktok_profile",
  "site_contacts",
  "bbb_businesses",
  "healthgrades_doctors",
  "miodottore_doctors",
  "local_business_leads",
  "business_directory",
  "paginegialle_profiles",
]);
const CHATGPT_HIDDEN_CATEGORIES = new Set(["leads"]);
function hiddenInChatGPT(c: any): boolean {
  return CHATGPT_HIDDEN_COLLECTORS.has(String(c?.slug)) || CHATGPT_HIDDEN_CATEGORIES.has(String(c?.category ?? "").toLowerCase());
}

/** Named tool sets for clients with small context windows. */
const TOOL_PRESETS: Record<string, string[]> = {
  lite: ["search_and_read"],
  web: ["search", "search_and_read", "scrape"],
  research: ["search", "search_and_read", "scrape", "map", "batch", "batch_status"],
  collectors: ["list_collectors", "run_collector", "collector_run_status"],
  proxies: ["list_proxies", "generate_proxies", "proxy_locations", "whitelist_ip"],
};

function parseToolList(raw: string | undefined): Set<string> | null {
  const names = String(raw ?? "")
    .split(/[\s,]+/)
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((n) => TOOL_PRESETS[n] ?? [n]);
  return names.length ? new Set(names) : null;
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const API_BASE = (opts.apiBase || process.env.QUANTUMPROXIES_API_BASE || "https://app.quantumproxies.io/api/v1").replace(
    /\/+$/,
    ""
  );
  const API_KEY = opts.apiKey ?? (process.env.QUANTUMPROXIES_API_KEY || "");

  /**
   * `quantumproxies-mcp/0.9.1 (http; client=cursor/1.7.2)`. Il client si sa solo
   * dopo l'initialize: prima (o su un transport che non lo espone) resta la sola
   * parte server, che è già abbastanza per separare l'MCP dal resto del traffico.
   */
  function userAgent(): string {
    let client = "";
    try {
      // Prima quello che il transport ha già in mano (HTTP stateless), poi
      // l'handshake di questa connessione (stdio, dove il server vive).
      const info = opts.clientInfo?.name ? opts.clientInfo : (server as any)?.server?.getClientVersion?.();
      if (info?.name) client = uaSafe(info.version ? `${info.name}/${info.version}` : info.name);
    } catch {
      /* introspezione senza handshake: nessun client da dichiarare */
    }
    // "; trial" marca le chiamate senza chiave, "; oauth" quelle entrate col login
    // OAuth: /admin/mcp le conta a parte (lib/mcpUsage).
    return `${MCP_UA_BASE} (${opts.transport ?? "stdio"}${client ? `; client=${client}` : ""}${KEYLESS ? "; trial" : ""}${opts.auth === "oauth" ? "; oauth" : ""})`;
  }

  /** No key, hosted endpoint, secret configured: calls go to the API as keyless traffic. */
  const KEYLESS = !API_KEY && opts.transport === "http" && Boolean(opts.anonToken);
  const KEYLESS_MESSAGE = missingKeyMessage(opts.transport ?? "stdio");
  const CHATGPT = opts.profile === "chatgpt";

  interface ApiResult {
    ok: boolean;
    status: number;
    data: any;
    /** Keyless tier: what the API says is left this minute (X-RateLimit-*). */
    keyless?: { remaining: number | null; limit: number | null };
  }

  /** The per-minute counter the API sends on keyless calls; undefined on keyed calls. */
  function keylessFrom(res: Response): ApiResult["keyless"] {
    if (!KEYLESS) return undefined;
    const n = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    return { remaining: n(res.headers.get("x-ratelimit-remaining")), limit: n(res.headers.get("x-ratelimit-limit")) };
  }

  /**
   * Turn a transport-level failure into something the caller can act on. Node's
   * fetch throws a bare `TypeError: fetch failed` and hides the real reason in
   * `cause`, so an unreachable API (the usual case: a local dev server that isn't
   * running) reaches the agent as two useless words. Name the target and the
   * cause instead — every minute spent guessing at "fetch failed" is a wasted run.
   *
   * Every URL goes last on its own line, and nothing follows it. These messages
   * get pasted into issues, forums and chat, where linkifiers extend a bare URL
   * over whatever punctuation comes next: `…/scraper/extract (ECONNREFUSED)`
   * turned into the indexed URL `…/scraper/extract%20(`, which Bing crawled as a
   * 404 (66 such pageviews on 2026-08-26). A newline is the only terminator they
   * all respect — angle brackets and quotes get swallowed just like parentheses.
   */
  function transportError(err: unknown, url: string): Error {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const code = cause?.code;
    const detail = code ?? cause?.message ?? (err as Error)?.message ?? String(err);
    let hint = "";
    if (code === "ECONNREFUSED" || code === "ECONNRESET")
      hint = " — nothing is listening there. Is the API up?";
    else if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      hint = " — host does not resolve. Check QUANTUMPROXIES_API_BASE.";
    else if ((err as Error)?.name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT")
      hint = " — request timed out after 90s.";
    else if (code === "CERT_HAS_EXPIRED" || code?.startsWith?.("ERR_TLS"))
      hint = " — TLS handshake failed.";
    return new Error(
      `Cannot reach the QuantumProxies API (${detail})${hint}\n` +
        `Endpoint: ${url}\n` +
        `QUANTUMPROXIES_API_BASE: ${API_BASE}`
    );
  }

  async function callApi(path: string, body: unknown, method: "POST" | "GET" | "DELETE" = "POST"): Promise<ApiResult> {
    if (!API_KEY && !KEYLESS) {
      return { ok: false, status: 401, data: { message: KEYLESS_MESSAGE } };
    }
    const url = `${API_BASE}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(KEYLESS
            ? {
                // Keyless: no Authorization at all — the API recognises the relay
                // by the shared secret and limits by the visitor's IP.
                "X-QD-Anon-Token": String(opts.anonToken),
                ...(opts.clientIp ? { "X-QD-Client-Ip": opts.clientIp } : {}),
              }
            : { Authorization: `Bearer ${API_KEY}` }),
          "Content-Type": "application/json",
          // Chi sta chiamando: l'handshake `initialize` porta nome e versione
          // del client MCP (claude-ai, Claude Code, cursor, vscode, n8n…) ed è
          // l'unico punto in cui si sa DOVE gira. Senza questo, /admin/mcp non
          // può dire né chi usa l'MCP né da dove.
          "User-Agent": userAgent(),
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
      return { ok: res.ok, status: res.status, data, keyless: keylessFrom(res) };
    }
    try {
      data = await res.json();
    } catch {
      data = { message: `Non-JSON response (HTTP ${res.status})` };
    }
    return { ok: res.ok, status: res.status, data, keyless: keylessFrom(res) };
  }

  /**
   * Indented JSON reads better in a small answer, but past a few KB the
   * indentation is pure overhead in the model's context: the full collector
   * catalog went out at 57 KB pretty-printed, the country list at 20 KB, and
   * ChatGPT starts struggling well before 100 KB. Large payloads go compact.
   */
  const PRETTY_MAX_CHARS = 12_000;
  function stringifyForModel(value: unknown): string {
    const pretty = JSON.stringify(value, null, 2);
    return pretty !== undefined && pretty.length > PRETTY_MAX_CHARS ? JSON.stringify(value) : pretty;
  }

  /** Rewrite the payload of a successful answer (the envelope stays as the API sent it). */
  function mapPayload(result: ApiResult, fn: (payload: any) => any): ApiResult {
    if (!result.ok || !result.data || typeof result.data !== "object") return result;
    const enveloped = "payload" in result.data;
    const payload = enveloped ? result.data.payload : result.data;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return result;
    let next: any;
    try {
      next = fn(payload);
    } catch {
      return result; // a trim must never cost the caller the answer
    }
    return { ...result, data: enveloped ? { ...result.data, payload: next } : next };
  }

  /**
   * Append what to do next to a plain API error ("Job not found", "Unknown
   * collector"): the agent has the one sentence of the error to recover from,
   * and naming the tool that fixes it saves a guessing round.
   */
  function withErrorHint(result: ApiResult, hint: (status: number, message: string) => string | undefined): ApiResult {
    if (result.ok || result.status === 401 || result.status === 402) return result;
    const code = result.data?.payload?.code;
    if (code === "account_required" || code === "anonymous_limit") return result;
    const message = String(result.data?.message || result.data?.error || "");
    const extra = hint(result.status, message);
    if (!extra) return result;
    const base = (message || `Request failed (HTTP ${result.status})`).replace(/[.\s]+$/, "");
    return { ...result, data: { ...(result.data ?? {}), message: `${base}. ${extra}` } };
  }

  /** Where a job's id comes from, and which tool polls it — the start answers say `id`, the poll tools take `jobId`. */
  function jobStarted(result: ApiResult, pollTool: string): ApiResult {
    return mapPayload(result, (p) =>
      typeof p.id === "string" ? { ...p, next: `Poll with ${pollTool} { jobId: "${p.id}" } until status is completed.` } : p
    );
  }
  function jobNotFound(startTool: string) {
    return (status: number, message: string) =>
      status === 404 || /not found|invalid .*id/i.test(message)
        ? `Pass the \`id\` returned by ${startTool} as jobId; ids belong to the account that started the job.`
        : undefined;
  }

  /**
   * A SERP answer carries every block the parser knows (~35 keys), and on a
   * plain query most are null or []: ads, shopping, flights, weather… plus
   * `general` repeating `search_parameters` and `related` repeating
   * `related_searches`. Absent now means "not on this page"; nothing that was
   * present is dropped.
   */
  function isEmptyValue(v: unknown): boolean {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    return typeof v === "object" && Object.keys(v as object).length === 0;
  }
  function pruneSerp(p: any): any {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(p)) {
      if (isEmptyValue(value)) continue;
      if (key === "general" && p.search_parameters) continue;
      if (key === "related" && Array.isArray(p.related_searches) && p.related_searches.length) continue;
      out[key] = Array.isArray(value)
        ? value.map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(Object.entries(item).filter(([, x]) => !isEmptyValue(x)))
              : item
          )
        : value;
    }
    return out;
  }

  function presetNotFound(status: number, message: string): string | undefined {
    return status === 404 || /preset not found/i.test(message)
      ? "Call list_parser_presets for the ids of this account's presets (save_parser_preset creates one)."
      : undefined;
  }

  /** Unwrap the API envelope { message, payload } and format for the model. */
  function toContent(result: ApiResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
    if (!result.ok) {
      const msg = result.data?.message || result.data?.error || `Request failed (HTTP ${result.status})`;
      // Keyless refusals already carry the whole explanation (what needs an
      // account, the register link): relay them as they are.
      const code = result.data?.payload?.code;
      if (code === "account_required" || code === "anonymous_limit") {
        return { content: [{ type: "text", text: msg }], isError: true };
      }
      // Auth and credit failures are the two the caller can actually fix, and
      // the two where a bare upstream string ("Invalid API key") ends the
      // evaluation. Everything else passes through unchanged.
      if (result.status === 401) {
        const text = msg === KEYLESS_MESSAGE ? msg : rejectedKeyMessage(msg, opts.transport ?? "stdio");
        return { content: [{ type: "text", text }], isError: true };
      }
      if (result.status === 402) {
        return { content: [{ type: "text", text: outOfCreditMessage(msg, opts.transport ?? "stdio") }], isError: true };
      }
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
    const payload = result.data?.payload ?? result.data;
    let text = typeof payload === "string" ? payload : stringifyForModel(payload);
    // Keyless: the account pitch lives in the server instructions; the result
    // carries a reminder only when the per-minute allowance is nearly gone.
    const k = result.keyless;
    if (k && k.remaining !== null && k.remaining <= 2) {
      const left = k.limit !== null ? `${k.remaining} of ${k.limit} requests left this minute. ` : "";
      text += `\n\n— Keyless tier: ${left}${KEYLESS_UPGRADE}`;
    }
    return { content: [{ type: "text", text }] };
  }

  /**
   * POST /feedback — the one call that works WITHOUT a key. A developer who
   * hits a bug during the no-key trial, or before they ever made a key, is
   * exactly who we want to hear from; asking them to sign up first would lose
   * the report. The key travels when there is one, so the backend can tie the
   * report to an account; otherwise the backend keeps only a hash of the IP.
   */
  async function postFeedback(body: Record<string, unknown>): Promise<ApiResult> {
    const url = `${API_BASE}/feedback`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
          "Content-Type": "application/json",
          "User-Agent": userAgent(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw transportError(err, url);
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = { message: `Non-JSON response (HTTP ${res.status})` };
    }
    return { ok: res.ok, status: res.status, data };
  }

  // Riallineato da scripts/sync-version.mjs, che `npm run build` esegue sempre:
  // `npm version` non tocca questo file, e il bundle MCPB ha già dichiarato
  // 0.9.0 con package.json a 0.9.1.
  const server = new McpServer(
    { name: "quantumproxies", version: "0.11.4" },
    // Keyless sessions get the tier explained where the model reads it first.
    KEYLESS ? { instructions: KEYLESS_INSTRUCTIONS } : undefined
  );
  // PostHog MCP Analytics (src/analytics.ts): no-op without POSTHOG_PROJECT_TOKEN.
  instrumentServer(server);

  // Without a key (keyless HTTP, or a stdio install not configured yet) the
  // client lists one prompt: what a free account adds, with the steps.
  if (!API_KEY) {
    server.prompt(
      "create_free_account",
      "What a free QuantumProxies account adds over the keyless tier, and how to connect the key",
      () => ({ messages: [{ role: "user", content: { type: "text", text: CREATE_ACCOUNT_PROMPT } }] })
    );
  }

  // ── scrape (extract) ────────────────────────────────────────────────────────
  server.tool(
    "scrape",
    "Use this when the user wants the content of one web page. Fetches the page from a residential IP and returns it as clean Markdown (or HTML/text). It tries a plain HTTP request with a Chrome-compatible TLS profile first and uses a headless browser only when the page needs JavaScript or the plain request is refused. Optionally runs structured extraction (CSS selectors or a stored preset) or AI extraction (natural-language prompt). Markdown keeps the complete page by default (content_mode 'smart': everything except nav/footer/cookie banners, with GFM tables and absolute links); use format 'html' to inspect the raw no-JS page. Optional browser `actions` (click, type) can submit forms on the target site. Use it only for pages the user is permitted to access.",
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
          "auto (default): plain HTTP first, headless browser when the page needs JavaScript or the HTTP request is refused. tls: plain HTTP only, never a browser — what a crawler without JavaScript sees, right for SEO checks. render: always use the browser."
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
        .describe("Cookies to send with the request as name→value (e.g. a consent or locale cookie). Only send cookies the user provided for this site."),
    },
    {
      title: "Scrape a web page",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
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

  // ── unlock (Web Unlocker) ───────────────────────────────────────────────────
  // A binary body (PNG render, PDF, image) rides in `bodyBase64`; past this size
  // it is dropped from the model's context and replaced with a note. A textual
  // `body` is kept whatever its size, like scrape's Markdown.
  const UNLOCK_BASE64_MAX = 200 * 1024;
  const UNLOCK_ALIASES: Record<string, string> = {
    session_id: "sessionId",
    tls_profile: "tlsProfile",
    auto_render: "autoRender",
    keep_headers: "keepHeaders",
    success_status_codes: "successStatusCodes",
    timeout_ms: "timeoutMs",
    fail_on_block: "failOnBlock",
    wait_for_selector: "waitForSelector",
    wait_ms: "waitMs",
    return_cookies: "returnCookies",
  };
  const unlockFull = {
      url: z.string().url().describe("Target URL"),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
        .optional()
        .describe("HTTP method (default GET). Only GET/HEAD are retried and escalated: any other method gets exactly one attempt."),
      headers: z
        .record(z.string())
        .optional()
        .describe(
          "Headers your own client would send. Browser identity headers (User-Agent, Accept, Sec-Fetch-*) are set to match the TLS profile unless keep_headers is set; auth, cookie, content-type and custom headers are forwarded as given."
        ),
      body: z.string().optional().describe("Request body as a UTF-8 string (JSON, form data, …)"),
      country: z.string().length(2).optional().describe("ISO country code for the proxy exit, e.g. 'us'"),
      session_id: z
        .string()
        .max(64)
        .optional()
        .describe("Sticky session id — reuse it across calls to keep the same exit IP"),
      tls_profile: z
        .enum(["chrome", "firefox", "safari", "safari_ios", "edge", "brave", "mobile"])
        .optional()
        .describe("Browser TLS profile for the connection (default chrome)"),
      tier: z
        .enum(["premium", "mobile"])
        .optional()
        .describe("Exit network: premium (default, residential) or mobile. Each tier bills its own prepaid unlocker balance."),
      render: z
        .enum(["html", "png"])
        .optional()
        .describe("Run the page in a headless browser instead of the TLS tier (GET only): 'html' returns the rendered DOM, 'png' a screenshot in bodyBase64"),
      auto_render: z
        .boolean()
        .optional()
        .describe("false: never retry a refused GET in the headless browser (default true)"),
      keep_headers: z
        .boolean()
        .optional()
        .describe("Send your own identity headers verbatim instead of the fingerprint's"),
      success_status_codes: z
        .array(z.number().int().min(100).max(599))
        .max(20)
        .optional()
        .describe("Origin statuses to accept as success: never treated as a block, never retried, relayed as-is (e.g. [404])"),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(120_000)
        .optional()
        .describe("Per-attempt timeout at the target, in ms"),
      fail_on_block: z
        .boolean()
        .optional()
        .describe("true: a request the site still refuses is returned as an error (HTTP 502) instead of a 200 payload with blocked: true"),
      wait_for_selector: z
        .string()
        .max(500)
        .optional()
        .describe("With render: wait for this CSS selector before capturing the page"),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(15_000)
        .optional()
        .describe("With render: extra wait after load, in ms"),
      return_cookies: z
        .boolean()
        .optional()
        .describe("Return the cookies set by the origin as name→value in payload.cookies"),
      cookies: z
        .record(z.string())
        .optional()
        .describe("Cookies to send as name→value (e.g. a consent cookie). Only send cookies the user provided for this site."),
    };
  // ChatGPT app: public pages only. No method that writes, no user-supplied
  // headers or cookies, no fingerprint options.
  const unlockPublic = {
    url: unlockFull.url,
    method: z.enum(["GET", "HEAD"]).optional().describe("HTTP method (default GET)"),
    country: unlockFull.country,
    tier: unlockFull.tier,
    render: unlockFull.render,
    success_status_codes: unlockFull.success_status_codes,
    timeout_ms: unlockFull.timeout_ms,
    wait_for_selector: unlockFull.wait_for_selector,
    wait_ms: unlockFull.wait_ms,
  };
  server.tool(
    "unlock",
    CHATGPT
      ? "Use this when the user needs a public page or public JSON endpoint exactly as the server returns it (status, headers, body, finalUrl) rather than scrape's Markdown, or a rendered HTML snapshot or screenshot of a public page. GET and HEAD only; it does not forward the user's logins, cookies or custom headers, so it works only on content that is publicly accessible. If the site does not return the page, the result says so (`blocked`, with the reason) instead of reporting a success; captchas are never solved. Use it only for sites and data the user is permitted to access."
      : "Use this when the user needs a site's raw HTTP response (a JSON API, a form POST, a page exactly as served) rather than scrape's Markdown. Sends the request (method, headers, body) from a residential IP with a browser-compatible TLS profile and returns status, headers, body (bodyBase64 for binary) and finalUrl. A GET or HEAD the site refuses is retried from another IP and, for GET, once in a headless browser; other methods get exactly one attempt. If the site still refuses, the response is marked `blocked` with the reason (`blockClass`, `vendor`) instead of being reported as a success; captchas are never solved. POST, PUT, PATCH and DELETE can change or delete data on the target site. Use it only for sites and data the user is permitted to access.",
    (CHATGPT ? unlockPublic : unlockFull) as typeof unlockFull,
    CHATGPT
      ? { title: "Fetch a public page as served", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
      : { title: "Send a raw HTTP request", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (args: Record<string, unknown>) => {
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (value === undefined) continue;
        body[UNLOCK_ALIASES[key] ?? key] = value;
      }
      const result = await callApi("/scraper/unlock", body);
      // The unlocker is a prepaid per-GB product with its own balance per tier,
      // not the pay-as-you-go API credit: the generic 402 text ("top up your
      // balance, the free allowance resets") sent people to the wrong page.
      if (result.status === 402 && result.data?.payload?.tier) {
        const msg = result.data?.message || "Web Unlocker bandwidth exhausted.";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${msg}\n\nThe Web Unlocker spends its own prepaid GB (one balance per tier: premium, mobile), ` +
                "separate from the pay-as-you-go API credit that scrape and search use — scrape is the alternative " +
                "that works on that credit. " +
                (opts.transport === "http"
                  ? // Plugin-directory rule: informational page only, no purchase link.
                    `Unlocker prices are listed at:\n   ${PRICING_URL}`
                  : `Unlocker GB are bought here:\n   ${UNLOCK_URL}`),
            },
          ],
          isError: true,
        };
      }
      const payload = result.ok ? result.data?.payload : undefined;
      if (
        payload &&
        typeof payload === "object" &&
        typeof payload.bodyBase64 === "string" &&
        payload.bodyBase64.length > UNLOCK_BASE64_MAX &&
        typeof payload.body !== "string"
      ) {
        const bytes = Math.floor((payload.bodyBase64.length * 3) / 4);
        payload.bodyBase64 = `binary body omitted (${bytes} bytes) — call the REST endpoint POST /scraper/unlock directly to download it`;
      }
      return toContent(result);
    }
  );

  // ── generate_parser ─────────────────────────────────────────────────────────
  server.tool(
    "generate_parser",
    "Look at a page ONCE with an LLM and get back CSS selectors that extract the fields you asked for. Pass the returned `parser` as the `extract` argument on every later scrape of that same layout and no AI runs again — it becomes a plain, deterministic extraction with no AI cost. Use this instead of ai_prompt whenever you will scrape more than a couple of pages of the same shape. Every selector is run against the page before being returned, so `report`/`coverage` tell you which fields are actually reliable.",
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
    {
      title: "Generate a parser",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) => toContent(await callApi("/scraper/parser/generate", args))
  );

  // ── parser presets (save / list / stats / heal) ─────────────────────────────
  server.tool(
    "save_parser_preset",
    "Store a generated parser under a name so it can be reused by id. Scrape later with scrape's `preset_id` instead of repeating the selectors, and every run is scored per field — when the recent success rate decays (the site redesigned), the preset regenerates itself from `source_url` and bumps a version. Give it a source_url whenever you can: without one it can never self-heal.",
    {
      name: z.string().max(120).describe("A name you'll recognise, e.g. 'shop product page'"),
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
    {
      title: "Save a parser preset",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
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
    {
      title: "List parser presets",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => toContent(await callApi("/scraper/parser/presets", null, "GET"))
  );

  server.tool(
    "parser_preset_stats",
    "How well a stored parser is still working: success rate per field, mean coverage over the recent runs, and whether it now counts as decayed (i.e. the site probably changed).",
    { preset_id: z.string().describe("The preset id returned by save_parser_preset") },
    {
      title: "Parser preset health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ preset_id }) =>
      toContent(withErrorHint(await callApi(`/scraper/parser/presets/${encodeURIComponent(preset_id)}/stats`, null, "GET"), presetNotFound))
  );

  server.tool(
    "heal_parser_preset",
    "Regenerate a preset's selectors now (the manual trigger for the automatic repair). Refetches the source page and adopts new selectors ONLY if they extract more than the current ones — a heal that finds nothing better leaves the preset untouched and is not billed.",
    {
      preset_id: z.string().describe("The preset id"),
      force: z.boolean().optional().describe("Skip the cooldown between heals"),
    },
    {
      title: "Repair a parser preset",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async ({ preset_id, force }) =>
      toContent(withErrorHint(await callApi(`/scraper/parser/presets/${encodeURIComponent(preset_id)}/heal`, { force }), presetNotFound))
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
    {
      title: "Audit a page for SEO",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) => toContent(await callApi("/scraper/seo-audit", args))
  );

  // ── ai_visibility ───────────────────────────────────────────────────────────
  server.tool(
    "ai_visibility",
    "Use this when the user asks whether AI assistants (ChatGPT, Claude, Perplexity, Google AI Overview, Bing Copilot) can find, read and cite a page; use seo_audit for classic Google indexing questions. On-page pass (always): the live robots.txt resolved for 24 AI crawlers per RFC 9309 with the deciding line, Content-Signal, one request sent with the GPTBot user-agent to check whether the site answers AI crawlers differently (skip it with no_bot_fetch), noindex/nosnippet/noai/data-nosnippet, text present without JavaScript, JSON-LD types and resolvable Organization/Person entities, heading outline, question-shaped headings, answer-first paragraph, lists/tables, numeric facts and quotes, chunk-sized sections, dateModified with age, author, outbound sources. Also readability grade, paragraph length, definitional openers, named-entity density, keyword stuffing, first-hand content, images/video, paywall and retired robots tokens. Retrievability: where Google ranks the page for its own H1 question and whether it is indexed (2 SERPs); a page that is not indexed is reported as a blocker. Google AI Overview and Bing Copilot report brand mentions only, because their no-JS results expose no sources. Returns a 0-100 score per pillar (retrievability, access, readability, structure, answerability, trust, plus offsite when requested), blockers that cap the score, every check with evidence and fix, and topFixes. Citation panel (when `queries` is set): asks each engine the questions and reports cited / mentioned / rank per (query × engine), share of voice across all cited domains, and the domains cited where the page is absent.",
    {
      url: z.string().url().describe("The page URL to audit"),
      queries: z
        .array(z.string().min(1).max(300))
        .max(10)
        .optional()
        .describe("Questions to ask the AI engines (max 10). Omit for the on-page audit only — each (query × engine) pair is a billed engine call."),
      engines: z
        .array(z.enum(["perplexity", "openai", "anthropic", "aio", "copilot", "deepseek"]))
        .optional()
        .describe("Engines to ask (default: all). aio = Google AI Overview read from a live SERP, copilot = Bing's generative answer, openai/anthropic = the vendors' APIs with web search (an approximation of ChatGPT/Claude search), deepseek = our own Google top-10 handed to DeepSeek to answer and cite (cheapest; measures whether a model picks your page from the same results)."),
      competitors: z
        .array(z.string().min(1).max(253))
        .max(20)
        .optional()
        .describe("Competitor domains to flag in the share of voice, e.g. ['example.com']"),
      brand: z
        .string()
        .max(80)
        .optional()
        .describe("Brand name to look for in the answer text ('mentioned' even when not cited). Defaults to the page's og:site_name / Organization name."),
      country: z.string().length(2).optional().describe("ISO country code for the proxy exit, e.g. 'us' — also the locale of the AI Overview / Copilot SERP"),
      no_render: z.boolean().optional().describe("Skip the rendered pass (cheaper — the two JS-parity checks are reported as skipped)"),
      no_bot_fetch: z.boolean().optional().describe("Skip the extra request sent with the GPTBot user-agent"),
      no_retrieval: z.boolean().optional().describe("Skip the retrievability probe (2 SERPs: Google rank of the page for its own H1 question, and whether it is indexed). On by default; a page that is not indexed is reported as a blocker."),
      offsite: z
        .boolean()
        .optional()
        .describe("Also measure mentions of the brand off the page with five searches (\"brand\" site:youtube.com / reddit.com / wikipedia.org / linkedin.com / review sites). Adds an `offsite` pillar; billed as 5 SERP calls."),
    },
    {
      title: "Audit a page for AI visibility",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) =>
      // access.bots lists all 24 crawlers with company, impact and rule — about
      // 6 KB that says "allowed, no rule" 24 times on most sites. Keep in full
      // only the bots a rule actually decides (blocked or explicitly allowed);
      // the verdict for the others is one line of names.
      toContent(
        mapPayload(await callApi("/scraper/ai-visibility", args), (p) => {
          const bots = p?.access?.bots;
          if (!Array.isArray(bots)) return p;
          const decided = bots.filter((b: any) => b && (b.allowed === false || b.rule));
          const open = bots.filter((b: any) => b && b.allowed !== false && !b.rule).map((b: any) => b.agent);
          return {
            ...p,
            access: {
              ...p.access,
              bots: decided,
              ...(open.length ? { botsAllowedByDefault: open } : {}),
            },
          };
        })
      )
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
      place_id: z.string().optional().describe("Google Maps place id for place_details — the hex '0x…:0x…' fid from maps/places results, a 'ChIJ…' place id or a numeric cid all work; served from Maps' place card over HTTP (name, address, phone, website, rating, reviews, category, weekly hours, open state) in about a second"),
      data_id: z
        .string()
        .optional()
        .describe("Maps data id, hex fid '0x…:0x…' (from maps/place_details results) — required for reviews"),
      product_ids: z
        .boolean()
        .optional()
        .describe("shopping only: render the Shopping grid so each result carries product_id/offer_id (the input of search_type=product). Costs a render; the default no-JS shopping page has no ids."),
      product_id: z.string().optional().describe("Google Shopping product id (the product_id of a shopping result — the rendered grid carries it) for search_type=product: the seller list with price, old price, discount, stock and delivery per merchant. Without it, pass a query and the first product is opened."),
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
        .describe("Reviews: the next_page_token from the previous reviews response's pagination block"),
    },
    {
      title: "Search the web",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) => toContent(mapPayload(await callApi("/scraper/serp", args), pruneSerp))
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
    {
      title: "Search and read results",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) =>
      // Every fetched page used to travel twice: once in sources[n].content and
      // again, verbatim, inside `context` under its [n] marker — double the
      // tokens for the same text. `context` is the part meant for the model, so
      // sources keep the citation fields and drop the copy (and the raw JSON-LD).
      toContent(
        mapPayload(await callApi("/ai/search", args), (p) => {
          if (typeof p.context !== "string" || !p.context || !Array.isArray(p.sources)) return p;
          return {
            ...p,
            sources: p.sources.map((s: any) => {
              if (!s || typeof s !== "object") return s;
              const { content: _content, ...rest } = s;
              if (rest.metadata && typeof rest.metadata === "object") {
                const { jsonLd: _jsonLd, ...meta } = rest.metadata;
                rest.metadata = meta;
              }
              return rest;
            }),
            note: "Each source's page text is in `context`, under the same [n] number as its `position`.",
          };
        })
      )
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
    {
      title: "Map a site's URLs",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
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
    {
      title: "Crawl a site",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) => toContent(jobStarted(await callApi("/scraper/crawl", args), "crawl_status"))
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
    {
      title: "Crawl status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ jobId, since, include_content }) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set("since", String(since));
      // Default to light polls (content off) so a large crawl doesn't flood the
      // context; the caller asks for content explicitly when it wants the text.
      query.set("include_content", include_content ? "true" : "false");
      const qs = query.toString();
      return toContent(
        withErrorHint(
          await callApi(`/scraper/crawl/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET"),
          jobNotFound("crawl")
        )
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
    {
      title: "Scrape URLs in batch",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (args) => toContent(jobStarted(await callApi("/scraper/batch", args), "batch_status"))
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
    {
      title: "Batch status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ jobId, since, include_content }) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set("since", String(since));
      if (include_content) query.set("include_content", "true");
      const qs = query.toString();
      return toContent(
        withErrorHint(
          await callApi(`/scraper/batch/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET"),
          jobNotFound("batch")
        )
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
    {
      title: "Bulk search",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (args) => toContent(jobStarted(await callApi("/scraper/serp/bulk", args), "search_bulk_status"))
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
    {
      title: "Bulk search status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ jobId, since }) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set("since", String(since));
      const qs = query.toString();
      return toContent(
        mapPayload(
          withErrorHint(
            await callApi(`/scraper/serp/bulk/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET"),
            jobNotFound("search_bulk")
          ),
          pruneSerp
        )
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
    {
      title: "Build a dataset",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (args) => toContent(jobStarted(await callApi("/scraper/datasets", args), "dataset_status"))
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
    {
      title: "Dataset status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ jobId, since, mode }) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set("since", String(since));
      if (mode) query.set("mode", mode);
      const qs = query.toString();
      return toContent(
        withErrorHint(
          await callApi(`/scraper/datasets/${encodeURIComponent(jobId)}${qs ? `?${qs}` : ""}`, null, "GET"),
          jobNotFound("create_dataset")
        )
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
    "List the account's proxy services of every type — Residential Basic/Premium/Private, Mobile, Mobile V2, Datacenter (static or traffic-based), ISP, IPv6 — with plan type, bandwidth left, expiry, whitelisted IPs and the orderId to pass to generate_proxies. Passwords are not listed here: generate_proxies returns ready-to-use credentials. Call this first to see which proxy plans are available.",
    {
      active: z
        .boolean()
        .optional()
        .describe("true: only non-expired services (recommended). false: only expired. Omit for all."),
      planType: z.enum(PLAN_TYPES).optional().describe("Only services of this plan type"),
      limit: z.number().int().min(1).max(100).optional().describe("Max services returned (default 50)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
    },
    {
      title: "List proxy services",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ active, planType, limit, offset }) => {
      const query = new URLSearchParams();
      if (active !== undefined) query.set("active", String(active));
      if (planType) query.set("planType", planType);
      if (limit !== undefined) query.set("limit", String(limit));
      if (offset !== undefined) query.set("offset", String(offset));
      const qs = query.toString();
      // A listing is not where credentials belong: the API row carries each
      // service's proxy password, and a list tool gets called casually, logged,
      // and pasted into chats. generate_proxies is the one tool that hands out
      // working credentials (the user asks for them there). The unit-less twins
      // of the *GB fields and `expiry` (= expiresAt) go too when they are equal.
      return toContent(
        mapPayload(await callApi(`/public/proxies${qs ? `?${qs}` : ""}`, null, "GET"), (p) => {
          if (!Array.isArray(p.proxies)) return p;
          return {
            ...p,
            proxies: p.proxies.map((row: any) => {
              if (!row || typeof row !== "object") return row;
              const { password, ...rest } = row;
              for (const [dup, twin] of [
                ["bandwidth", "bandwidthGB"],
                ["bandwidthLeft", "bandwidthLeftGB"],
                ["bandwidthUsed", "bandwidthUsedGB"],
                ["expiry", "expiresAt"],
              ] as const) {
                if (dup in rest && twin in rest && rest[dup] === rest[twin]) delete rest[dup];
              }
              return password ? { ...rest, password: "hidden: call generate_proxies with this orderId for ready-to-use credentials" } : rest;
            }),
          };
        })
      );
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
    {
      title: "Generate proxy credentials",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
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
    {
      title: "Proxy locations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
      if ((lvl === "states" || lvl === "cities") && !country) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: level '${lvl}' needs \`country\` (a code from level 'countries', e.g. 'us').`,
            },
          ],
          isError: true,
        };
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
    {
      title: "Manage the IP whitelist",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
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
    "Use this to find a ready-made Collector for a task before calling run_collector. Collectors are paid, versioned scrapers you run with a semantic input (keyword + location, place id, product id, domain…) instead of URLs, grouped in categories such as local businesses and maps, e-commerce, jobs, news, travel, finance, developer registries, research, classifieds, public records and domain/DNS data. Returns a compact catalog (slug, name, category, tagline, price per delivered result, required input fields, health), optionally filtered by `category`; pass `slug` to get one collector's full input/output schema and example input. Billing is pay-per-success: only delivered rows are charged.",
    {
      category: z.string().max(40).optional().describe("Optional category filter (e.g. 'local', 'ecommerce', 'jobs', 'news', 'travel', 'leads', 'finance', 'dev', 'gaming', 'osint', 'research', 'classifieds', 'knowledge')"),
      slug: z.string().max(80).optional().describe("Return ONE collector's full definition (input and output schema, example input, price, health) instead of the compact catalog"),
    },
    {
      title: "List collectors",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ category, slug }) => {
      // The API returns the whole catalog, every collector with its full input
      // and output schema and examples (~650 KB for 100+ collectors), and does
      // not filter by category. Sent as is, that blows any client's context and
      // fails in ChatGPT. So: a compact catalog here, and the full definition of
      // ONE collector on request, which is what run_collector actually needs.
      const res = await callApi(`/scraper/collectors`, null, "GET");
      if (!res.ok) return toContent(res);
      const payload: any = res.data?.payload ?? res.data;
      const catalog: any[] = Array.isArray(payload?.collectors) ? payload.collectors : Array.isArray(payload) ? payload : [];
      const all = CHATGPT ? catalog.filter((c) => !hiddenInChatGPT(c)) : catalog;
      const answer = (value: unknown) => toContent({ ...res, data: { payload: value } });
      if (slug) {
        const one = all.find((c) => c?.slug === slug);
        if (!one) {
          return {
            content: [{ type: "text" as const, text: `No collector with slug '${slug}'. Call list_collectors without slug for the catalog.` }],
            isError: true,
          };
        }
        return answer({ collector: one, billing: payload?.billing });
      }
      const wanted = category?.trim().toLowerCase();
      const matches = wanted
        ? all.filter((c) => String(c?.category ?? "").toLowerCase() === wanted || String(c?.category_label ?? "").toLowerCase() === wanted)
        : all;
      const byCategory: Record<string, number> = {};
      for (const c of all) byCategory[c?.category ?? "other"] = (byCategory[c?.category ?? "other"] ?? 0) + 1;
      if (wanted && matches.length === 0) {
        return answer({ count: 0, category, available_categories: byCategory });
      }
      return answer({
        count: matches.length,
        ...(wanted ? { category } : { categories: byCategory }),
        collectors: matches.map((c) => ({
          slug: c.slug,
          name: c.name,
          category: c.category,
          tagline: c.tagline,
          unit: c.unit,
          price_per_result_usd: c.price?.your_usd ?? c.price?.list_usd ?? null,
          max_results: c.max_results,
          required_input: c.input_schema?.required ?? [],
          input_fields: Object.keys(c.input_schema?.properties ?? {}),
          health: c.health?.status ?? null,
        })),
        next: "Call list_collectors with `slug` for the full input and output schema and an example input before run_collector.",
      });
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
    {
      title: "Run a collector",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async ({ slug, input, async: asyncRun }) => {
      if (CHATGPT && CHATGPT_HIDDEN_COLLECTORS.has(slug)) {
        return {
          content: [{ type: "text" as const, text: `The collector '${slug}' is not available in this app. Call list_collectors for the ones that are.` }],
          isError: true,
        };
      }
      return toContent(
        withErrorHint(
          await callApi(`/scraper/collectors/${encodeURIComponent(slug)}/run`, { ...input, ...(asyncRun ? { async: true } : {}) }),
          (_status, message) =>
            /unknown collector/i.test(message)
              ? "Call list_collectors for the valid slugs."
              : /invalid input/i.test(message)
                ? `Call list_collectors with slug "${slug}" for its input schema and an example input.`
                : undefined
        )
      );
    }
  );

  server.tool(
    "collector_run_status",
    "Fetch a Collector run by run_id: status (queued|running|done|failed), result count, cost, partial flag and the result rows. Use after run_collector returned 202/async. Pass format 'csv' to get the rows as CSV text.",
    {
      run_id: z.string().min(1).describe("The run id returned by run_collector"),
      format: z.enum(["json", "csv"]).optional().describe("Return rows as JSON (default) or CSV text"),
    },
    {
      title: "Collector run status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ run_id, format }) => {
      const qs = format === "csv" ? "?format=csv" : "";
      return toContent(
        withErrorHint(await callApi(`/scraper/collectors/runs/${encodeURIComponent(run_id)}${qs}`, null, "GET"), (status, message) =>
          status === 404 || /not found|invalid run id/i.test(message)
            ? "Pass the run_id that run_collector returned (runs are visible only to the account that started them)."
            : undefined
        )
      );
    }
  );

  // ── report ──────────────────────────────────────────────────────────────────
  // The feedback channel. Agents hit the edges of a product long before a human
  // writes to support: a selector that returns nothing, a collector that misses
  // a field, a tool that is missing. This is the one tool that runs with or
  // without a key, so a trial user can report what stopped them.
  server.tool(
    "report",
    "Send feedback to the QuantumProxies team: a bug (a result that is wrong or empty after a retry, a broken parser, a blocked page that should work), a missing tool, site, option or collector, or a question about behaviour or pricing. Use it when the user asks to report something. When a tool here clearly failed at its job, or the user needs something no tool here covers, offer to send a report and call it only if the user agrees. Do NOT call it for a missing, rejected or unset API key, for the no-key trial or the balance being used up, for a network timeout, or for your own wrong input: those are fixed by the user, not by the team, and the tool that failed already said how. One report per issue, never one per retry. The report (the fields below, plus the account it comes from when the call is authenticated) is stored and forwarded to the QuantumProxies support team; it cannot be recalled. Works without an API key.",
    {
      kind: z
        .enum(["bug", "feature", "question", "other"])
        .describe("bug: something returned wrong/empty/errored. feature: a missing tool, option, site or collector. question: unclear behaviour or pricing. other: anything else."),
      message: z
        .string()
        .min(10)
        .max(4000)
        .describe("What happened or what is missing, in plain words. Include the URL/query/collector involved when there is one."),
      tool: z.string().max(64).optional().describe("Name of the tool involved, e.g. 'scrape' or 'run_collector' (omit for general feedback)"),
      expected: z.string().max(2000).optional().describe("What the user needed to get back"),
      actual: z.string().max(2000).optional().describe("What actually came back (error text, empty payload, wrong fields…). Trim page content; a short excerpt is enough."),
      tool_input: z
        .record(z.unknown())
        .optional()
        .describe("The arguments passed to the failing tool, so the team can reproduce it. Leave out cookies, credentials and anything private."),
      contact: z
        .string()
        .max(200)
        .optional()
        .describe("Optional email or handle to follow up on — ask the user before sending it; never send it unasked."),
    },
    {
      title: "Report a bug or request a feature",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ kind, message, tool, expected, actual, tool_input, contact }) => {
      const result = await postFeedback({
        kind,
        message,
        tool,
        expected,
        actual,
        toolInput: tool_input,
        contact,
        source: "mcp",
        client: opts.clientInfo?.name
          ? uaSafe(opts.clientInfo.version ? `${opts.clientInfo.name}/${opts.clientInfo.version}` : opts.clientInfo.name)
          : undefined,
        server: MCP_UA_BASE,
        transport: opts.transport ?? "stdio",
      });
      if (!result.ok) {
        const msg = result.data?.message || result.data?.error || `Request failed (HTTP ${result.status})`;
        return { content: [{ type: "text", text: `The report could not be sent: ${msg}` }], isError: true };
      }
      const id = result.data?.payload?.id;
      const text =
        (result.data?.message || "Thanks — your report reached the team.") +
        (id ? `\nReference: ${id}` : "") +
        (contact ? "" : "\nNo contact was included, so the team cannot reply to this report.");
      return { content: [{ type: "text", text }] };
    }
  );

  // Tool subset (QUANTUMPROXIES_TOOLS=web, or ?tools=web on the hosted URL).
  const wanted = parseToolList(opts.tools ?? process.env.QUANTUMPROXIES_TOOLS);
  const registry = (server as any)._registeredTools as Record<string, { remove(): void }> | undefined;
  if (wanted && registry && Object.keys(registry).some((name) => wanted.has(name))) {
    for (const [name, tool] of Object.entries(registry)) if (!wanted.has(name)) tool.remove();
  }

  return server;
}
