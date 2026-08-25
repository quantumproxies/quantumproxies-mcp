#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, MISSING_KEY_MESSAGE } from "./server.js";

if (!process.env.QUANTUMPROXIES_API_KEY) {
  // Warn on stderr (stdout is the MCP transport and must stay clean) but keep
  // serving: clients that only introspect — tools/list, directory scanners,
  // registries — must still get an answer. Tool calls fail with the same
  // message instead of the process dying at startup.
  console.error(MISSING_KEY_MESSAGE);
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Ready. Logs go to stderr so stdout stays a clean JSON-RPC channel.
  console.error("QuantumProxies MCP server running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
