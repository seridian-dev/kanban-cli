import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";

/** Fake client: records agentApi:search calls and answers one card per status. */
function fakeClient() {
  const searches: any[] = [];
  const client = {
    async query(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      switch (name) {
        case "preferences:getCliDefaults": return { workspaceSlug: null, projectKey: null };
        case "projects:list": return [{ _id: "p1", key: "WEB", name: "Web" }];
        case "organizations:listMine": return [];
        case "agentApi:search":
          searches.push(args);
          return [{ key: `WEB-${searches.length}`, type: "task", status: args.status ?? "todo", title: "T" }];
        default: throw new Error(`unexpected query ${name}`);
      }
    },
    async mutation() { throw new Error("no writes expected"); },
  };
  return { client: client as unknown as CliConvexClient, searches };
}

async function run(argv: string[], client: CliConvexClient): Promise<{ out: string; error?: { message: string; code?: number } }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    await main(argv, { client });
    return { out: lines.join("\n") };
  } catch (e) {
    return { out: lines.join("\n"), error: { message: (e as Error).message, code: (e as { code?: number }).code } };
  } finally {
    console.log = log;
  }
}

let dir: string;
const saved = { KANBAN_CONFIG_FILE: process.env.KANBAN_CONFIG_FILE, KANBAN_PROJECT: process.env.KANBAN_PROJECT, KANBAN_WORKSPACE: process.env.KANBAN_WORKSPACE };
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "kanban-status-"));
  process.env.KANBAN_CONFIG_FILE = join(dir, "config.json");
  delete process.env.KANBAN_PROJECT;
  delete process.env.KANBAN_WORKSPACE;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("items list --status (production: agentApi:search ArgumentValidationError)", () => {
  it("an unknown status is a usage error that names the valid statuses, and nothing is sent", async () => {
    const { client, searches } = fakeClient();
    const r = await run(["items", "list", "--project", "WEB", "--status", "doing"], client);
    assert.equal(r.error?.code, 2, "a bad --status must exit 2, not reach the server");
    assert.match(r.error!.message, /backlog, todo, in_progress, in_review, done/);
    assert.equal(searches.length, 0);
  });

  it("several statuses separated by spaces or commas list each one, with review meaning in_review", async () => {
    const { client, searches } = fakeClient();
    const r = await run(["items", "list", "--project", "WEB", "--status", "in_progress todo,review", "--json"], client);
    assert.equal(r.error, undefined, r.error?.message);
    assert.deepEqual(searches.map((s) => s.status), ["in_progress", "todo", "in_review"]);
    assert.deepEqual(JSON.parse(r.out).map((row: any) => row.key), ["WEB-1", "WEB-2", "WEB-3"]);
  });

  it("--limit caps the combined list across statuses", async () => {
    const { client } = fakeClient();
    const r = await run(["items", "list", "--project", "WEB", "--status", "todo,done", "--limit", "1", "--json"], client);
    assert.equal(JSON.parse(r.out).length, 1);
  });
});
