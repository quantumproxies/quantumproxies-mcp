/**
 * PostHog MCP Analytics — one `$mcp_tool_call` per tool invocation (plus
 * `$mcp_tools_list`, `$mcp_initialize` and `$exception` on failures) into the
 * project named by the environment.
 *
 * Opt-in by environment, nothing else changes: without POSTHOG_PROJECT_TOKEN
 * no client is created and the server behaves exactly as before, so the
 * published stdio package stays silent on a user's machine unless they set the
 * token themselves. The hosted endpoint (remote.ts) gets the token from its
 * systemd unit.
 *
 *   POSTHOG_PROJECT_TOKEN  phc_… project API key
 *   POSTHOG_HOST           ingestion host, default https://eu.i.posthog.com
 *
 * One client per process; shut down (= flushed) on SIGTERM/SIGINT and at
 * `beforeExit`, which is what the long-running remote server needs. The
 * stateless remote entry also flushes after every request so a call shows
 * up within seconds instead of waiting for the batch interval.
 */

import { PostHog } from "posthog-node";
import { instrument } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let client: PostHog | null | undefined;

function posthogClient(): PostHog | null {
  if (client !== undefined) return client;
  const token = (process.env.POSTHOG_PROJECT_TOKEN || "").trim();
  if (!token) {
    client = null;
    return client;
  }
  const host = (process.env.POSTHOG_HOST || "https://eu.i.posthog.com").trim();
  const created = new PostHog(token, { host });
  client = created;
  const drain = async () => {
    try {
      await created.shutdown();
    } catch {
      /* the process is leaving either way */
    }
  };
  // Neither entry installed signal handlers before, so the default (exit) is
  // kept: drain first, then leave with the same status.
  process.once("SIGTERM", () => void drain().then(() => process.exit(0)));
  process.once("SIGINT", () => void drain().then(() => process.exit(0)));
  process.once("beforeExit", () => void drain());
  return client;
}

/** Wrap one McpServer. A no-op without a token. */
export function instrumentServer(server: McpServer): void {
  const ph = posthogClient();
  if (!ph) return;
  // No injected tool parameters: `context` and `llm_model` were required on
  // every tool with descriptions that instruct the model what to write, which
  // the Anthropic and OpenAI app directories treat as model instructions and
  // conversation-data collection. Calls, tools, clients and errors are still
  // captured; the intent is inferred from the tool name instead.
  instrument(server, ph, {
    context: false,
    captureModel: false,
    intentFallback: (request: any) => (request?.params?.name ? `tool:${String(request.params.name)}` : null),
  });
}

/** Push whatever is queued now (best effort). */
export async function flushAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.flush();
  } catch {
    /* never let analytics fail a request */
  }
}
