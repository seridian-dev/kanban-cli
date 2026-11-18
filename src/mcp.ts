/**
 * `kanban mcp [--client claude|codex|chatgpt|grok] [--mcp-url URL]` prints the remote MCP URL and a setup for each AI client.
 * It never reads or prints a credential: every snippet refers to the KANBAN_TOKEN environment variable, and ChatGPT and
 * Grok sign in through OAuth when the client prompts for it. No network call is made.
 */
import { UsageError } from "./lib.js";

export const DEFAULT_MCP_URL = "https://kanban.seridian.dev/mcp";
export const CLIENT_IDS = ["claude", "codex", "chatgpt", "grok"] as const;
export type McpClient = (typeof CLIENT_IDS)[number];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, or plain http only for a loopback development server. Query strings are refused so no token can ride in a URL. */
export function resolveMcpUrl(flags: Record<string, string | true>, env: Record<string, string | undefined>): string {
  const raw = typeof flags["mcp-url"] === "string" ? flags["mcp-url"] : env.KANBAN_MCP_URL ?? DEFAULT_MCP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("The MCP URL is not a valid URL");
  }
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new UsageError("The MCP URL must use https (http is allowed only for localhost)");
  if (url.search || url.hash) throw new UsageError("The MCP URL must not carry a query string or fragment; credentials go in the Authorization header");
  return url.toString();
}

/** Setup text for one client. `url` must come from resolveMcpUrl. */
export function mcpSetup(client: McpClient, url: string): string {
  switch (client) {
    case "claude":
      return [
        "Claude Code (recommended: install the kanban-claude plugin, which sets this up for you):",
        `  claude mcp add --transport http kanban ${url} --header "Authorization: Bearer $KANBAN_TOKEN"`,
        "claude.ai (custom connector, Settings > Connectors): paste the URL; under Request headers add",
        "  Authorization: Bearer <your agent credential>",
      ].join("\n");
    case "codex":
      return [
        "Codex: add to ~/.codex/config.toml (or a trusted project's .codex/config.toml):",
        "",
        "[mcp_servers.kanban]",
        `url = "${url}"`,
        'bearer_token_env_var = "KANBAN_TOKEN"',
        "",
        "Then export KANBAN_TOKEN in the shell that starts Codex.",
      ].join("\n");
    case "chatgpt":
      return [
        "ChatGPT: add a custom MCP server (Settings > Apps, or the connector settings in your plan).",
        `  URL: ${url}`,
        "  Sign in when prompted.",
      ].join("\n");
    case "grok":
      return [
        `Grok (consumer app): grok.com > Connectors > New Connector > Custom, then enter ${url}`,
        "  Sign in when prompted.",
        "  API (xAI Responses tools): { type: \"mcp\", server_url, server_label, authorization }; the exact field syntax",
        "  is UNCONFIRMED from the public docs. Check docs.x.ai/developers/tools/remote-mcp before relying on it.",
      ].join("\n");
    default:
      throw new UsageError(`--client must be one of ${CLIENT_IDS.join(", ")}`);
  }
}

export function mcpCommand(flags: Record<string, string | true>, env: Record<string, string | undefined>): string {
  const url = resolveMcpUrl(flags, env);
  const client = flags.client;
  if (client === undefined) return [`Kanban MCP URL: ${url}`, "", ...CLIENT_IDS.map((c) => `== ${c}\n${mcpSetup(c, url)}`)].join("\n\n");
  if (typeof client !== "string") throw new UsageError(`--client must be one of ${CLIENT_IDS.join(", ")}`);
  return mcpSetup(client as McpClient, url);
}
