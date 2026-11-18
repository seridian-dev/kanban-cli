import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLIENT_IDS, DEFAULT_MCP_URL, mcpCommand, mcpSetup, resolveMcpUrl } from "./mcp.js";
import { UsageError } from "./lib.js";

const KANBAN = fileURLToPath(new URL("./kanban.js", import.meta.url));

describe("kanban mcp (setup printer)", () => {
  it("the default MCP URL is the production remote server", () => {
    assert.equal(DEFAULT_MCP_URL, "https://kanban.seridian.dev/mcp");
    assert.equal(resolveMcpUrl({}, {}), DEFAULT_MCP_URL);
  });

  it("KANBAN_MCP_URL and --mcp-url override the default, and must be https or loopback http", () => {
    assert.equal(resolveMcpUrl({}, { KANBAN_MCP_URL: "http://localhost:3000/mcp" }), "http://localhost:3000/mcp");
    assert.equal(resolveMcpUrl({ "mcp-url": "http://127.0.0.1:3211/mcp" }, {}), "http://127.0.0.1:3211/mcp");
    assert.throws(() => resolveMcpUrl({ "mcp-url": "http://kanban.example.com/mcp" }, {}), UsageError);
  });

  it("a URL that carries a token in its query string is refused", () => {
    assert.throws(() => resolveMcpUrl({ "mcp-url": "https://kanban.seridian.dev/mcp?token=abc" }, {}), UsageError);
  });

  it("every supported client renders a setup, and an unknown client is a usage error", () => {
    assert.deepEqual([...CLIENT_IDS], ["claude", "codex", "chatgpt", "grok"]);
    for (const client of CLIENT_IDS) assert.ok(mcpSetup(client, DEFAULT_MCP_URL).length > 40, `${client} setup is too short`);
    assert.throws(() => mcpSetup("gemini" as never, DEFAULT_MCP_URL), UsageError);
  });

  it("each setup names the MCP URL and reads the credential from KANBAN_TOKEN, never a literal token", () => {
    for (const client of CLIENT_IDS) {
      const text = mcpSetup(client, DEFAULT_MCP_URL);
      assert.ok(text.includes(DEFAULT_MCP_URL), `${client} names the URL`);
      assert.doesNotMatch(text, /kbn_agt_[A-Za-z0-9_-]{8,}/, `${client} has no real-looking credential`);
    }
    assert.ok(mcpSetup("codex", DEFAULT_MCP_URL).includes('bearer_token_env_var = "KANBAN_TOKEN"'));
    assert.ok(mcpSetup("claude", DEFAULT_MCP_URL).includes("$KANBAN_TOKEN"));
  });

  it("ChatGPT and Grok say to add the URL and sign in when prompted (OAuth is live)", () => {
    const chatgpt = mcpSetup("chatgpt", DEFAULT_MCP_URL);
    assert.match(chatgpt, /sign in when prompted/i);
    assert.doesNotMatch(chatgpt, /being added|until it ships|not accepted/i, "ChatGPT text must not describe OAuth as unshipped");
    const grok = mcpSetup("grok", DEFAULT_MCP_URL);
    assert.match(grok, /sign in when prompted/i);
    assert.doesNotMatch(grok, /UNCONFIRMED: which authentication types/, "Grok consumer app auth is now OAuth sign-in");
  });

  it("Claude Code and Codex keep the pasted-credential setup", () => {
    assert.match(mcpSetup("claude", DEFAULT_MCP_URL), /Authorization: Bearer/);
    assert.match(mcpSetup("codex", DEFAULT_MCP_URL), /export KANBAN_TOKEN/);
  });

  it("mcpCommand without --client lists every client, and with --client prints only that one", () => {
    const all = mcpCommand({}, {});
    assert.ok(all.startsWith(`Kanban MCP URL: ${DEFAULT_MCP_URL}`));
    for (const client of CLIENT_IDS) assert.ok(all.includes(`== ${client}`), `all lists ${client}`);
    assert.equal(mcpCommand({ client: "codex" }, {}), mcpSetup("codex", DEFAULT_MCP_URL));
    assert.throws(() => mcpCommand({ client: true }, {}), UsageError);
  });

  it("@smoke `kanban mcp --client codex` prints the URL and exits 0 without a backend or credential", () => {
    const run = spawnSync(process.execPath, [KANBAN, "mcp", "--client", "codex"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, KANBAN_NO_UPDATE: "1" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(DEFAULT_MCP_URL));
    assert.ok(run.stdout.includes('bearer_token_env_var = "KANBAN_TOKEN"'));
  });

  it("@smoke `kanban mcp --client gemini` is a usage error (exit 2)", () => {
    const run = spawnSync(process.execPath, [KANBAN, "mcp", "--client", "gemini"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, KANBAN_NO_UPDATE: "1" },
    });
    assert.equal(run.status, 2, run.stderr);
  });
});
