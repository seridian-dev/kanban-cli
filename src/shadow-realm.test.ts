import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";

/** Server-side banish, summon and destroy (Kanban KAN-257). The fake records every call; no server is contacted. */

interface Call { kind: "query" | "mutation"; name: string; args: any }

interface FakeOptions {
  /** The card is in the Shadow Realm. Banished cards resolve only with includeBanished, as on the server. */
  banished?: boolean;
  /** Thrown by every mutation, to simulate a server rule such as a role check. */
  mutationError?: Error;
  /** What shadowRealm:list returns. */
  realm?: unknown;
}

const BANISHED_AT = Date.UTC(2026, 9, 14, 12, 0, 0);

const DEFAULT_REALM = {
  banished: [{
    _id: "id-WEB-1", key: "WEB-1", title: "Old spike", type: "epic", status: "done", labels: [],
    projectId: "p1", projectKey: "WEB", projectName: "Web", deletedAt: BANISHED_AT, deletedBy: "owner", subtreeCount: 3,
  }],
  ghosts: [],
  canRestore: true,
  canDestroy: true,
  purgeDays: null,
};

function fakeClient(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const mutations = () => calls.filter((c) => c.kind === "mutation");
  const item = (key: string) => ({
    _id: `id-${key}`, key, title: "Card", type: "story", status: "done", priority: "none",
    ...(opts.banished ? { deletedAt: BANISHED_AT, deletedBy: "owner" } : {}),
  });
  const client = {
    async query(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      calls.push({ kind: "query", name, args });
      switch (name) {
        case "preferences:getCliDefaults": return { workspaceSlug: null, projectKey: null };
        case "organizations:getBySlug": return args.slug === "acme" ? { id: "org1", slug: "acme", name: "Acme" } : null;
        case "organizations:listMine": return [];
        case "projects:list": return [{ _id: "p1", key: "WEB", name: "Web" }];
        case "projects:getByKey": return { _id: "p1", key: args.key, organizationId: "org1" };
        case "agentApi:getByKey": {
          if (opts.banished && !args.includeBanished) return null;
          return item(args.key);
        }
        case "agentApi:search": return [{ key: "WEB-2" }, { key: "WEB-3" }];
        case "shadowRealm:list": return opts.realm ?? DEFAULT_REALM;
        default: throw new Error(`unexpected query ${name}`);
      }
    },
    async mutation(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      calls.push({ kind: "mutation", name, args });
      if (opts.mutationError) throw opts.mutationError;
      switch (name) {
        case "workItems:banish": return { banished: 3 };
        case "workItems:restore": return { restored: 3 };
        case "workItems:destroyForever": return { destroyed: 3 };
        default: throw new Error(`unexpected mutation ${name}`);
      }
    },
  };
  return { client: client as unknown as CliConvexClient, calls, mutations };
}

/** Runs the CLI with a fake client and returns what it printed on stdout. */
async function run(argv: string[], client: CliConvexClient): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    await main(argv, { client });
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

/** Runs the CLI expecting a failure; returns the error class, message, and exit code. */
async function failure(argv: string[], client: CliConvexClient) {
  try {
    await run(argv, client);
  } catch (e) {
    const err = e as Error & { code?: number };
    return { name: err.constructor.name, message: err.message, code: err.code };
  }
  assert.fail(`expected ${argv.join(" ")} to fail`);
}

let configDir: string;
const saved = { KANBAN_CONFIG_FILE: process.env.KANBAN_CONFIG_FILE, KANBAN_PROJECT: process.env.KANBAN_PROJECT, KANBAN_WORKSPACE: process.env.KANBAN_WORKSPACE, KANBAN_USER: process.env.KANBAN_USER };

before(async () => {
  // A config file that does not exist: no saved defaults or folder links leak into these tests.
  configDir = await mkdtemp(join(tmpdir(), "kanban-shadow-realm-"));
  process.env.KANBAN_CONFIG_FILE = join(configDir, "config.json");
  delete process.env.KANBAN_PROJECT;
  delete process.env.KANBAN_WORKSPACE;
  delete process.env.KANBAN_USER;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("items rm banishes to the Shadow Realm", () => {
  it("calls workItems.banish, never the old hard delete, and prints the restore hint", async () => {
    const { client, calls } = fakeClient();
    const text = await run(["items", "rm", "WEB-1", "--yes"], client);
    assert.equal(text, "Banished WEB-1 to the Shadow Realm (restore with: kanban items restore WEB-1)");
    const names = calls.filter((c) => c.kind === "mutation").map((c) => c.name);
    assert.deepEqual(names, ["workItems:banish"]);
    assert.equal(calls.find((c) => c.kind === "mutation")!.args.actor, "cli");
  });

  it("--json prints the server result", async () => {
    const { client } = fakeClient();
    assert.deepEqual(JSON.parse(await run(["items", "rm", "WEB-1", "--yes", "--json"], client)), { banished: 3 });
  });

  it("without --yes refuses before any call, and says it banishes", async () => {
    const { client, calls } = fakeClient();
    const err = await failure(["items", "rm", "WEB-1"], client);
    assert.equal(err.code, 2);
    assert.match(err.message, /Refusing to banish WEB-1 and its subtree \(2 item\(s\)\) without --yes/);
    assert.equal(calls.filter((c) => c.kind === "mutation").length, 0);
  });

  it("a card that is already banished is refused with the restore hint, and nothing is sent", async () => {
    const { client, mutations } = fakeClient({ banished: true });
    const err = await failure(["items", "rm", "WEB-1", "--yes"], client);
    assert.equal(err.code, 2);
    assert.equal(err.message, "WEB-1 is already in the Shadow Realm. Summon it back with: kanban items restore WEB-1");
    assert.equal(mutations().length, 0);
  });

  it("--dry-run lists the whole subtree and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    const printed = JSON.parse(await run(["items", "rm", "WEB-1", "--yes", "--dry-run", "--json"], client));
    assert.equal(mutations().length, 0);
    assert.deepEqual(printed.wouldChange, [{ action: "items.rm", project: "WEB", keys: ["WEB-1", "WEB-2", "WEB-3"] }]);
  });
});

describe("items rm --purge is refused: cards in the Shadow Realm can't be destroyed", () => {
  const message = (key: string) => `Cards in the Shadow Realm can't be destroyed. Use \`kanban items restore ${key}\` to bring one back.`;

  it("exits 2 with the restore hint, whether or not the card is banished, and sends nothing", async () => {
    for (const banished of [true, false]) {
      const { client, calls, mutations } = fakeClient({ banished });
      const err = await failure(["items", "rm", "WEB-1", "--purge", "--yes"], client);
      assert.equal(err.code, 2);
      assert.equal(err.message, message("WEB-1"));
      assert.equal(calls.length, 0, "no lookup or call");
      assert.equal(mutations().length, 0);
    }
  });

  it("is refused the same way without --yes, and with --dry-run or --json", async () => {
    const { client, calls } = fakeClient({ banished: true });
    assert.equal((await failure(["items", "rm", "WEB-1", "--purge"], client)).message, message("WEB-1"));
    assert.equal((await failure(["items", "rm", "WEB-1", "--purge", "--yes", "--dry-run", "--json"], client)).message, message("WEB-1"));
    assert.equal(calls.length, 0);
  });

  it("never calls workItems.destroyForever", async () => {
    const { client, mutations } = fakeClient({ banished: true });
    await failure(["items", "rm", "WEB-1", "--purge", "--yes"], client);
    assert.equal(mutations().some((m) => m.name === "workItems:destroyForever"), false);
  });
});

describe("items restore summons a banished card back", () => {
  it("calls workItems.restore and prints the summon message", async () => {
    const { client, calls } = fakeClient({ banished: true });
    const text = await run(["items", "restore", "WEB-1"], client);
    assert.equal(text, "Summoned WEB-1 back from the Shadow Realm");
    const mutation = calls.find((c) => c.kind === "mutation")!;
    assert.equal(mutation.name, "workItems:restore");
    assert.equal(mutation.args.id, "id-WEB-1");
  });

  it("--json prints the server result", async () => {
    const { client } = fakeClient({ banished: true });
    assert.deepEqual(JSON.parse(await run(["items", "restore", "WEB-1", "--json"], client)), { restored: 3 });
  });

  it("a card that is not in the Shadow Realm is a usage error, and nothing is sent", async () => {
    const { client, mutations } = fakeClient({ banished: false });
    const err = await failure(["items", "restore", "WEB-1"], client);
    assert.equal(err.code, 2);
    assert.equal(err.message, "WEB-1 is not in the Shadow Realm, so there is nothing to restore");
    assert.equal(mutations().length, 0);
  });

  it("a missing key is a usage error", async () => {
    const { client } = fakeClient();
    const err = await failure(["items", "restore"], client);
    assert.equal(err.code, 2);
    assert.match(err.message, /Missing item key/);
  });

  it("--dry-run reports the summon and sends nothing", async () => {
    const { client, mutations } = fakeClient({ banished: true });
    const printed = JSON.parse(await run(["items", "restore", "WEB-1", "--dry-run", "--json"], client));
    assert.equal(mutations().length, 0);
    assert.deepEqual(printed.wouldChange, [{ action: "items.restore", project: "WEB", keys: ["WEB-1"] }]);
  });
});

describe("shadow-realm list", () => {
  it("lists banished cards in the workspace with who and when, as JSON", async () => {
    const { client, calls, mutations } = fakeClient();
    const printed = JSON.parse(await run(["shadow-realm", "list", "--workspace", "acme", "--json"], client));
    assert.equal(printed.banished[0].key, "WEB-1");
    assert.equal(printed.canRestore, true);
    const realm = calls.find((c) => c.name === "shadowRealm:list")!;
    assert.deepEqual(realm.args, { organizationId: "org1" });
    assert.equal(mutations().length, 0, "listing is read-only");
  });

  it("--project KEY filters to that project's id", async () => {
    const { client, calls } = fakeClient();
    await run(["shadow-realm", "list", "--workspace", "acme", "--project", "WEB", "--json"], client);
    const realm = calls.find((c) => c.name === "shadowRealm:list")!;
    assert.deepEqual(realm.args, { organizationId: "org1", projectId: "p1" });
  });

  it("human output is a table of banished cards", async () => {
    const { client } = fakeClient();
    const text = await run(["shadow-realm", "list", "--workspace", "acme"], client);
    assert.match(text, /^KEY\s+TYPE\s+STATUS\s+TITLE\s+BANISHED BY\s+WHEN/m);
    assert.match(text, /WEB-1\s+epic\s+done\s+Old spike\s+owner\s+2026-10-14/);
  });

  it("says when the Shadow Realm is empty", async () => {
    const { client } = fakeClient({ realm: { ...DEFAULT_REALM, banished: [] } });
    assert.equal(await run(["shadow-realm", "list", "--workspace", "acme"], client), "The Shadow Realm is empty.");
  });

  it("without a workspace it is a usage error that names the fix", async () => {
    const { client, calls } = fakeClient();
    const err = await failure(["shadow-realm", "list"], client);
    assert.equal(err.code, 2);
    assert.match(err.message, /Shadow Realm lives in a workspace\. Pass --workspace SLUG/);
    assert.equal(calls.some((c) => c.name === "shadowRealm:list"), false);
  });

  it("a bare shadow-realm is a usage error", async () => {
    const { client } = fakeClient();
    const err = await failure(["shadow-realm"], client);
    assert.equal(err.code, 2);
    assert.match(err.message, /Use `kanban shadow-realm list/);
  });
});

describe("help and schema describe the Shadow Realm", () => {
  it("agent-help and the full help name restore and shadow-realm list, and never offer purge", async () => {
    const agent = await run(["agent-help"], fakeClient().client);
    assert.match(agent, /kanban items restore WEB-12/);
    assert.doesNotMatch(agent, /--purge/);
    assert.match(agent, /shadow-realm list/);
    const full = await run(["help"], fakeClient().client);
    assert.match(full, /kanban items rm WEB-12 --yes\s+banishes/);
    assert.match(full, /kanban items restore WEB-12/);
    assert.doesNotMatch(full, /--purge/);
    assert.match(full, /kanban shadow-realm list/);
  });
});
