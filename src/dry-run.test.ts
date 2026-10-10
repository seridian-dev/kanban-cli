import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";

/** Fake Convex client: answers the reads the commands need and records every mutation. */
function fakeClient() {
  const mutations: { name: string; args: any }[] = [];
  const client = {
    async query(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      switch (name) {
        case "preferences:getCliDefaults": return { workspaceSlug: null, projectKey: null };
        case "projects:list": return [{ _id: "p1", key: "WEB", name: "Web" }];
        case "projects:getByKey": return { _id: "p1", key: args.key ?? "WEB" };
        case "agentApi:getByKey": return { _id: `id-${args.key}`, key: args.key, status: "todo", title: "T", type: "story" };
        case "agentApi:search": return [{ key: "WEB-2" }, { key: "WEB-3" }];
        case "sprints:listByProject": return [{ _id: "s1", name: "S1", state: "planning" }];
        case "organizations:listMine": return [];
        case "workItems:listByProject": return [];
        default: throw new Error(`unexpected query ${name}`);
      }
    },
    async mutation(ref: unknown, args: any) {
      mutations.push({ name: getFunctionName(ref as never), args });
      return { created: [], deleted: 3, assigned: 0 };
    },
  };
  return { client: client as unknown as CliConvexClient, mutations };
}

/** Runs the CLI with a fake client and returns what it printed. */
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

/** The outcome of a run: "ok" or the error class and message. */
async function outcome(argv: string[], client: CliConvexClient): Promise<string> {
  try {
    await run(argv, client);
    return "ok";
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
}

let configDir: string;
const saved = { KANBAN_CONFIG_FILE: process.env.KANBAN_CONFIG_FILE, KANBAN_PROJECT: process.env.KANBAN_PROJECT, KANBAN_WORKSPACE: process.env.KANBAN_WORKSPACE, KANBAN_USER: process.env.KANBAN_USER };

before(async () => {
  // A config file that does not exist: no saved defaults or folder links leak into these tests.
  configDir = await mkdtemp(join(tmpdir(), "kanban-dry-run-"));
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

/** Every write command, with a real-run variant and a dry-run variant. */
const WRITES: { name: string; argv: string[]; action: string; keys: string[] }[] = [
  { name: "items create", argv: ["items", "create", "--project", "WEB", "--type", "story", "--title", "New", "--parent", "WEB-1"], action: "items.create", keys: ["WEB-1"] },
  { name: "items update", argv: ["items", "update", "WEB-5", "--status", "done", "--title", "X"], action: "items.update", keys: ["WEB-5"] },
  { name: "items move", argv: ["items", "move", "WEB-5", "--status", "in_progress", "--after", "WEB-6"], action: "items.move", keys: ["WEB-5"] },
  { name: "items rm", argv: ["items", "rm", "WEB-1", "--yes"], action: "items.rm", keys: ["WEB-1", "WEB-2", "WEB-3"] },
  { name: "items breakdown", argv: ["items", "breakdown", "WEB-1", "--text", "a\nb"], action: "items.breakdown", keys: ["WEB-1"] },
  { name: "items distribute", argv: ["items", "distribute", "WEB-1", "--people", "sam,alex"], action: "items.distribute", keys: ["WEB-1"] },
  { name: "items bulk", argv: ["items", "bulk", "--ids", "WEB-1,WEB-2", "--status", "done"], action: "items.bulk", keys: ["WEB-1", "WEB-2"] },
  { name: "comment add", argv: ["comment", "add", "WEB-1", "--body", "hello"], action: "comment.add", keys: ["WEB-1"] },
  { name: "sprints create", argv: ["sprints", "create", "--project", "WEB", "--name", "S2"], action: "sprints.create", keys: [] },
  { name: "sprints start", argv: ["sprints", "start", "S1", "--project", "WEB"], action: "sprints.start", keys: [] },
  { name: "sprints complete", argv: ["sprints", "complete", "S1", "--project", "WEB"], action: "sprints.complete", keys: [] },
  { name: "projects create", argv: ["projects", "create", "--key", "NEW", "--name", "New"], action: "projects.create", keys: [] },
  { name: "projects update", argv: ["projects", "update", "WEB", "--name", "Web 2"], action: "projects.update", keys: ["WEB"] },
  { name: "git connect", argv: ["git", "connect", "--project", "WEB", "--provider", "github", "--repo", "a/b"], action: "git.connect", keys: [] },
  { name: "git rotate-secret", argv: ["git", "rotate-secret", "--project", "WEB", "--connection", "c1"], action: "git.rotate-secret", keys: [] },
];

describe("--dry-run on write commands", () => {
  for (const cmd of WRITES) {
    it(`${cmd.name}: makes no mutation call and reports the targets`, async () => {
      const { client, mutations } = fakeClient();
      const printed = JSON.parse(await run([...cmd.argv, "--dry-run", "--json"], client));
      assert.equal(mutations.length, 0, "dry run must not mutate");
      assert.equal(printed.dryRun, true);
      assert.equal(printed.wouldChange.length, 1);
      assert.equal(printed.wouldChange[0].action, cmd.action);
      assert.deepEqual(printed.wouldChange[0].keys, cmd.keys);
    });

    it(`${cmd.name}: the same command without --dry-run sends exactly one mutation`, async () => {
      const { client, mutations } = fakeClient();
      await run([...cmd.argv, "--json"], client);
      assert.equal(mutations.length, 1);
    });
  }

  it("items update lists the fields that would change, as typed", async () => {
    const { client, mutations } = fakeClient();
    const printed = JSON.parse(await run(["items", "update", "WEB-5", "--status", "done", "--depends-on", "WEB-3", "--dry-run", "--json"], client));
    assert.equal(mutations.length, 0);
    assert.deepEqual(printed.wouldChange[0].fields, { status: "done", "depends-on": "WEB-3" });
  });

  it("items rm --dry-run --yes lists the whole subtree", async () => {
    const { client, mutations } = fakeClient();
    const printed = JSON.parse(await run(["items", "rm", "WEB-1", "--yes", "--dry-run", "--json"], client));
    assert.equal(mutations.length, 0);
    assert.deepEqual(printed.wouldChange, [{ action: "items.rm", project: "WEB", keys: ["WEB-1", "WEB-2", "WEB-3"] }]);
  });

  it("human output names each planned change and that nothing changed", async () => {
    const { client } = fakeClient();
    const text = await run(["items", "move", "WEB-5", "--status", "in_review", "--dry-run"], client);
    assert.match(text, /^Dry run, nothing changed:/);
    assert.match(text, /items\.move WEB-5 status=in_review/);
  });

  it("the dry-run JSON has exactly the dryRun and wouldChange keys", async () => {
    const { client } = fakeClient();
    const printed = JSON.parse(await run(["comment", "add", "WEB-1", "--body", "hi", "--dry-run", "--json"], client));
    assert.deepEqual(Object.keys(printed).sort(), ["dryRun", "wouldChange"]);
  });
});

describe("--dry-run keeps usage errors identical", () => {
  const cases: string[][] = [
    ["items", "create", "--project", "WEB", "--title", "no type"],
    ["items", "update", "WEB-1"],
    ["items", "move", "WEB-1"],
    ["items", "rm", "WEB-1"],
    ["items", "update", "WEB-1", "--points", "abc"],
    ["items", "breakdown", "WEB-1", "--text", "   "],
    ["items", "bulk", "--status", "done"],
    ["comment", "add", "not-a-key", "--body", "x"],
    ["sprints", "create", "--project", "WEB"],
  ];
  for (const argv of cases) {
    it(`${argv.join(" ")}: same error with and without --dry-run, and no mutation`, async () => {
      const plain = fakeClient();
      const dry = fakeClient();
      const expected = await outcome(argv, plain.client);
      const actual = await outcome([...argv, "--dry-run"], dry.client);
      assert.notEqual(expected, "ok", "the case should be an error");
      assert.equal(actual, expected);
      assert.equal(dry.mutations.length, 0);
    });
  }

  it("items rm WEB-1 --dry-run without --yes refuses, as the real run does", async () => {
    const { client, mutations } = fakeClient();
    const message = await outcome(["items", "rm", "WEB-1", "--dry-run"], client);
    assert.match(message, /^CliError: Refusing to delete WEB-1 .* without --yes$|^UsageError: Refusing/);
    assert.equal(mutations.length, 0);
  });
});
