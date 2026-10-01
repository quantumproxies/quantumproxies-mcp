#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, MCP_VERSION } from "./server.js";
import { flushAnalytics } from "./analytics.js";

/**
 * Remote (Streamable HTTP) entry — the hosted flavour of the same server.
 *
 * Stateless by design: every POST builds a fresh McpServer bound to the
 * credential of that request, so one endpoint serves every customer and
 * nothing is shared between requests.
 *
 * Authorization follows the MCP spec (OAuth 2.1). This server is the
 * protected resource: it publishes RFC 9728 metadata pointing at the app
 * (app.quantumproxies.io) as authorization server, and answers 401 with a
 * WWW-Authenticate challenge to any request without credentials, which is
 * what makes Claude, Cursor & co. open the sign-in and consent screen.
 * Two credentials are accepted:
 *   - an OAuth access token (mcp_at_…), introspected against the app over the
 *     internal ingress; the app answers with the API key of that grant and we
 *     call the API with it. The OAuth token is never forwarded (no token
 *     passthrough);
 *   - an API key (qp_live_…) as a Bearer token or X-Api-Key, as before.
 *
 * Runs behind nginx: listens on localhost only, TLS terminates upstream.
 */

const PORT = Number(process.env.PORT || 9310);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 4 * 1024 * 1024;

/** This endpoint as an OAuth resource (RFC 8707 indicator) and who issues its tokens. */
const RESOURCE = (process.env.MCP_OAUTH_RESOURCE || "https://api.quantumproxies.io/mcp").replace(/\/+$/, "");
const AUTH_SERVER = (process.env.MCP_OAUTH_ISSUER || "https://app.quantumproxies.io").replace(/\/+$/, "");
/** The app's introspection route, reached over the loopback ingress (nginx denies /api/v1/internal/* at the edge). */
const INTROSPECT_URL = process.env.MCP_OAUTH_INTROSPECT_URL || "http://127.0.0.1:3090/api/v1/internal/oauth/introspect";
const INTERNAL_TOKEN = (process.env.MCP_INTERNAL_TOKEN || "").trim();

const RESOURCE_METADATA_URL = (() => {
  const u = new URL(RESOURCE);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
})();

/** RFC 9728 protected resource metadata. */
const RESOURCE_METADATA = {
  resource: RESOURCE,
  authorization_servers: [AUTH_SERVER],
  scopes_supported: ["mcp"],
  bearer_methods_supported: ["header"],
  resource_name: "QuantumProxies MCP server",
  resource_documentation: "https://quantumproxies.io/mcp-server",
};

/**
 * The visitor's IP as nginx/Cloudflare hand it to us. Behind Cloudflare the
 * authoritative header is CF-Connecting-IP (X-Forwarded-For's first hop is
 * caller-controlled); then X-Real-IP; then the LAST X-Forwarded-For hop our
 * own proxy appended; else the socket. Shape-checked so header garbage never
 * becomes a rate-limit identifier on the API.
 */
function clientIpFrom(req: IncomingMessage): string | undefined {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const plausible = (v: string | undefined): string | undefined => {
    const s = v?.trim();
    if (!s || s.length > 45) return undefined;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return s.split(".").every((o) => Number(o) <= 255) ? s : undefined;
    return /^[0-9a-fA-F:.]+$/.test(s) && s.includes(":") ? s : undefined;
  };
  const cf = plausible(one(req.headers["cf-connecting-ip"]));
  if (cf) return cf;
  const real = plausible(one(req.headers["x-real-ip"]));
  if (real) return real;
  const xff = one(req.headers["x-forwarded-for"]);
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    for (let k = hops.length - 1; k >= 0; k--) {
      const ip = plausible(hops[k]);
      if (ip) return ip;
    }
  }
  return plausible(req.socket?.remoteAddress ?? undefined);
}

/**
 * Chi sta chiamando, su un endpoint che per scelta non tiene stato.
 *
 * Ogni POST costruisce un McpServer nuovo, quindi `getClientVersion()` è
 * popolato solo sulla richiesta che porta l'`initialize`: su una `tools/call`
 * — l'unica che poi chiama l'API — è vuoto, e senza questo il traffico MCP in
 * produzione arriva firmato `quantumproxies-mcp/0.9.2 (http)` e basta, senza
 * dire da dove. Due fonti, in ordine:
 *   1. il corpo dell'initialize, che porta `params.clientInfo`;
 *   2. il token `Mcp-Session-Id` che l'SDK conia per le sessioni stateless e
 *      che incapsula nome e versione del client (`cn`/`cv`) — il client ce lo
 *      rimanda a ogni richiesta successiva.
 * Se il formato del token cambia, il decode fallisce in silenzio e si torna a
 * firmare senza `client=`: mai un errore in faccia a chi sta lavorando.
 */
function clientFrom(req: IncomingMessage, parsed: unknown): { name?: string; version?: string } | null {
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of msgs) {
    const info = (m as any)?.method === "initialize" ? (m as any)?.params?.clientInfo : null;
    if (info?.name) return { name: String(info.name), version: info.version ? String(info.version) : undefined };
  }
  const raw = req.headers["mcp-session-id"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8"));
    if (json?.cn) return { name: String(json.cn), version: json.cv ? String(json.cv) : undefined };
  } catch {
    /* token opaco o di un altro formato: si firma senza client */
  }
  return null;
}

function credentialFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || undefined;
  const alt = req.headers["x-api-key"];
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  return undefined;
}

const OAUTH_TOKEN_RE = /^mcp_at_[a-f0-9]{64}$/;

/**
 * Introspection cache: token hash -> API key, for at most a minute (and never
 * past the token's expiry). A revoked connection therefore stops working
 * within a minute at worst.
 */
type Grant = { apiKey: string; client: string; clientName: string };
const introspected = new Map<string, Grant & { until: number }>();

async function apiKeyForToken(token: string): Promise<Grant | null> {
  const id = createHash("sha256").update(token).digest("hex");
  const hit = introspected.get(id);
  if (hit && hit.until > Date.now()) return hit;
  introspected.delete(id);
  if (!INTERNAL_TOKEN) {
    console.error("OAuth token received but MCP_INTERNAL_TOKEN is not set: cannot introspect");
    return null;
  }
  const res = await fetch(INTROSPECT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify({ token, resource: RESOURCE }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => {
    console.error("introspection failed:", err?.message || err);
    return null;
  });
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    active?: boolean;
    api_key?: string;
    exp?: number;
    client?: string;
    client_name?: string;
  } | null;
  if (!data?.active || typeof data.api_key !== "string") return null;
  const until = Math.min(Date.now() + 60_000, (data.exp ?? 0) * 1000);
  if (introspected.size > 5000) introspected.clear();
  const grant = { apiKey: data.api_key, client: String(data.client ?? ""), clientName: String(data.client_name ?? "") };
  introspected.set(id, { ...grant, until });
  return grant;
}

/**
 * ChatGPT connects with its Client ID Metadata Document (https://chatgpt.com/...)
 * and announces itself as openai-mcp. Those sessions get the ChatGPT app's tool
 * set (see BuildOptions.profile); every other client is unchanged.
 */
function isChatGPT(grant: Grant | null, clientInfo: { name?: string } | null): boolean {
  if (grant && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(grant.client)) return true;
  if (grant && /^chatgpt$/i.test(grant.clientName.trim())) return true;
  return /^openai-mcp$/i.test(clientInfo?.name ?? "");
}

/** `?tools=web` or `?tools=search,scrape` on the endpoint URL: a smaller tool set for local models. */
function toolsFrom(req: IncomingMessage): string | undefined {
  const query = (req.url || "").split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("tools") || undefined;
}

/** 401 with the RFC 9728 challenge: this is what starts the OAuth flow in the client. */
function challenge(res: ServerResponse, error?: "invalid_token", description?: string) {
  const parts = [`resource_metadata="${RESOURCE_METADATA_URL}"`, `scope="mcp"`];
  if (error) parts.unshift(`error="${error}"`, `error_description="${description ?? "The access token is invalid or expired"}"`);
  res
    .writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer ${parts.join(", ")}` })
    .end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: error
            ? "The access token is invalid or expired. Reconnect to sign in again."
            : "Authentication required. Connect with OAuth (your MCP client opens the sign-in page) or send your API key as Authorization: Bearer <key>.",
        },
        id: null,
      })
    );
}

const httpServer = createServer(async (req, res) => {
  // Browser-based MCP clients need CORS; the spec-relevant headers are exposed.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && path === "/healthz") {
    // Liveness, the build and whether OAuth introspection is configured. Never the secret.
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ ok: true, version: MCP_VERSION, oauth: { resource: RESOURCE, issuer: AUTH_SERVER, introspection: Boolean(INTERNAL_TOKEN) } })
    );
    return;
  }
  if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    res
      .writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" })
      .end(JSON.stringify(RESOURCE_METADATA));
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no SSE stream to resume, no session to delete.
    res.writeHead(405, { "content-type": "application/json", allow: "POST, OPTIONS" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This is a stateless MCP endpoint — send JSON-RPC over POST." },
        id: null,
      })
    );
    return;
  }

  let raw = "";
  let overflow = false;
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      overflow = true;
      break;
    }
  }
  if (overflow) {
    res.writeHead(413, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Body too large" }, id: null })
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })
    );
    return;
  }

  // Self-hosted single-tenant mode: the operator's key from the environment
  // stands in for a missing credential. The hosted endpoints never set it, so
  // there a request without credentials always gets the OAuth challenge.
  const credential = credentialFrom(req) || (process.env.QUANTUMPROXIES_API_KEY || "").trim() || undefined;
  if (!credential) {
    challenge(res);
    return;
  }
  let apiKey = credential;
  let grant: Grant | null = null;
  const viaOAuth = OAUTH_TOKEN_RE.test(credential);
  if (viaOAuth) {
    grant = await apiKeyForToken(credential);
    if (!grant) {
      challenge(res, "invalid_token");
      return;
    }
    apiKey = grant.apiKey;
  }
  const clientInfo = clientFrom(req, parsed);

  try {
    const server = buildServer({
      apiKey,
      transport: "http",
      clientInfo,
      clientIp: clientIpFrom(req),
      auth: viaOAuth ? "oauth" : "key",
      profile: isChatGPT(grant, clientInfo) ? "chatgpt" : undefined,
      tools: toolsFrom(req),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session tracking
      enableJsonResponse: true, // plain JSON answers instead of an SSE stream
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
    // Stateless: this request is the whole "invocation", so push its events now.
    void flushAnalytics();
  } catch (err) {
    console.error("request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null })
      );
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `QuantumProxies remote MCP listening on http://${HOST}:${PORT} (stateless streamable HTTP; OAuth resource ${RESOURCE}, ` +
      (INTERNAL_TOKEN ? "introspection on)" : "introspection OFF: no MCP_INTERNAL_TOKEN, only API keys work)")
  );
});
