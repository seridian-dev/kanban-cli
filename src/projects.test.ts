import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";
import { parseArgs, parseProjectUpdate, UsageError } from "./lib.js";

const KANBAN = new URL("./kanban.js", import.meta.url).pathname;

interface FakeOptions {
  /** Projects returned by projects:list. Two rows with one key simulate an ambiguous key. */
  projects?: { _id: string; key: string; name: string; organizationId?: string }[];
  workspaces?: { _id: string; slug: string }[];
}

/** Fake Convex client: answers the reads the command needs and records every mutation. */
function fakeClient(options: FakeOptions = {}) {
  const mutations: { name: string; args: any }[] = [];
  const projects = options.projects ?? [{ _id: "p1", key: "WEB", name: "Web" }];
  const client = {
    async query(ref: unknown) {
      const name = getFunctionName(ref as never);
      switch (name) {
        case "preferences:getCliDefaults": return { workspaceSlug: null, projectKey: null };
        case "projects:list": return projects;
        case "organizations:listMine": return options.workspaces ?? [];
        default: throw new Error(`unexpected query ${name}`);
      }
    },
    async mutation(ref: unknown, args: any) {
      mutations.push({ name: getFunctionName(ref as never), args });
      return null;
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

let configDir: string;
const saved = { KANBAN_CONFIG_FILE: process.env.KANBAN_CONFIG_FILE, KANBAN_PROJECT: process.env.KANBAN_PROJECT, KANBAN_WORKSPACE: process.env.KANBAN_WORKSPACE, KANBAN_USER: process.env.KANBAN_USER };

before(async () => {
  // No saved config or folder links, so defaults from the developer's machine never leak in.
  configDir = await mkdtemp(join(tmpdir(), "kanban-projects-update-"));
  process.env.KANBAN_CONFIG_FILE = join(configDir, "config.json");
  delete process.env.KANBAN_PROJECT;
  delete process.env.KANBAN_WORKSPACE;
  delete process.env.KANBAN_USER;
});
after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(configDir, { recursive: true, force: true });
});

describe("parseProjectUpdate (kanban projects update KEY)", () => {
  it("reads the key and the name and description flags", () => {
    const { positionals, flags } = parseArgs(["projects", "update", "web", "--name", "Web app", "--description", "Customer site"]);
    assert.deepEqual(parseProjectUpdate(positionals, flags), { key: "WEB", name: "Web app", description: "Customer site" });
  });

  it("an empty --description clears it, and --workspace is optional", () => {
    const { positionals, flags } = parseArgs(["projects", "update", "SITES", "--description", "", "--workspace=seridian"]);
    assert.deepEqual(parseProjectUpdate(positionals, flags), { key: "SITES", description: "", workspaceSlug: "seridian" });
  });

  it("refuses a missing or malformed key with a usage error", () => {
    assert.throws(() => parseProjectUpdate(["projects", "update"], { name: "X" }), UsageError);
    assert.throws(() => parseProjectUpdate(["projects", "update", "TOOLONGKEY"], { name: "X" }), UsageError);
  });

  it("refuses an update with neither --name nor --description", () => {
    assert.throws(() => parseProjectUpdate(["projects", "update", "WEB"], {}), /--name or --description/);
  });

  it("refuses a blank --name, which the server would also reject", () => {
    assert.throws(() => parseProjectUpdate(["projects", "update", "WEB"], { name: "   " }), UsageError);
  });
});

describe("kanban projects update", () => {
  it("with no flags is a usage error and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    await assert.rejects(run(["projects", "update", "WEB"], client), UsageError);
    assert.equal(mutations.length, 0);
  });

  it("with no flags exits 2 from the executable", () => {
    const configFile = join(configDir, "exit-config.json");
    const result = spawnSync(process.execPath, [KANBAN, "projects", "update", "WEB"], {
      encoding: "utf8",
      // A loopback URL is accepted without any network discovery, so this never reaches production.
      env: { ...process.env, KANBAN_CONFIG_FILE: configFile, KANBAN_URL: "http://127.0.0.1:9", KANBAN_NO_UPDATE_CHECK: "1" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--name or --description/);
  });

  it("sends name and description to projects:update with the key", async () => {
    const { client, mutations } = fakeClient();
    await run(["projects", "update", "web", "--name", "Web app", "--description", "Customer site", "--json"], client);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].name, "projects:update");
    assert.deepEqual(mutations[0].args, { key: "WEB", name: "Web app", description: "Customer site" });
  });

  it("an empty --description is sent as an empty string, which clears it", async () => {
    const { client, mutations } = fakeClient();
    await run(["projects", "update", "WEB", "--description", "", "--json"], client);
    assert.deepEqual(mutations[0].args, { key: "WEB", description: "" });
  });

  it("a name-only update does not send a description", async () => {
    const { client, mutations } = fakeClient();
    await run(["projects", "update", "WEB", "--name", "Renamed", "--json"], client);
    assert.deepEqual(mutations[0].args, { key: "WEB", name: "Renamed" });
  });

  it("does not need --workspace when the key is unique, and omits it from the payload", async () => {
    const { client, mutations } = fakeClient({
      projects: [{ _id: "p1", key: "WEB", name: "Web", organizationId: "o1" }],
      workspaces: [{ _id: "o1", slug: "acme" }],
    });
    await run(["projects", "update", "WEB", "--name", "Renamed", "--json"], client);
    assert.deepEqual(mutations[0].args, { key: "WEB", workspaceSlug: "acme", name: "Renamed" });
  });

  it("passes --workspace through as workspaceSlug", async () => {
    const { client, mutations } = fakeClient();
    await run(["projects", "update", "WEB", "--name", "Renamed", "--workspace", "acme", "--json"], client);
    assert.deepEqual(mutations[0].args, { key: "WEB", workspaceSlug: "acme", name: "Renamed" });
  });

  it("asks for --workspace when the key exists in more than one workspace, and sends nothing", async () => {
    const { client, mutations } = fakeClient({
      projects: [
        { _id: "p1", key: "WEB", name: "Web", organizationId: "o1" },
        { _id: "p2", key: "WEB", name: "Web 2", organizationId: "o2" },
      ],
      workspaces: [{ _id: "o1", slug: "acme" }, { _id: "o2", slug: "globex" }],
    });
    await assert.rejects(run(["projects", "update", "WEB", "--name", "Renamed"], client), /exists in multiple workspaces \(acme, globex\)\. Pass --workspace SLUG/);
    assert.equal(mutations.length, 0);
  });

  it("--dry-run reports the planned change and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    const printed = JSON.parse(await run(["projects", "update", "WEB", "--name", "Renamed", "--description", "", "--dry-run", "--json"], client));
    assert.equal(mutations.length, 0);
    assert.deepEqual(printed, {
      dryRun: true,
      wouldChange: [{ action: "projects.update", keys: ["WEB"], fields: { name: "Renamed", description: "" } }],
    });
  });

  it("prints the updated key in human output", async () => {
    const { client } = fakeClient();
    assert.equal(await run(["projects", "update", "WEB", "--name", "Renamed"], client), "Updated project WEB");
  });
});
