#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";

/**
 * Remote (Streamable HTTP) entry — the hosted flavour of the same server.
 *
 * Stateless by design: every POST builds a fresh McpServer bound to the API
 * key taken from that request's Authorization header, so one endpoint serves
 * every customer with their own key and nothing is shared between requests.
 * Introspection (initialize / tools/list) works without a key; tool calls
 * without one answer 401 with instructions, same as the stdio entry.
 *
 * Runs behind nginx: listens on localhost only, TLS terminates upstream.
 */

const PORT = Number(process.env.PORT || 9310);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 4 * 1024 * 1024;

function keyFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const alt = req.headers["x-api-key"];
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  return undefined; // buildServer falls back to the process env (self-host single-tenant)
}

const httpServer = createServer(async (req, res) => {
  // Browser-based MCP clients need CORS; the spec-relevant headers are exposed.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
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

  try {
    const server = buildServer({ apiKey: keyFrom(req), transport: "http" });
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
  console.error(`QuantumProxies remote MCP listening on http://${HOST}:${PORT} (stateless streamable HTTP)`);
});
