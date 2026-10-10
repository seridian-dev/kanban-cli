import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";
import { UsageError } from "./lib.js";
import { findFolder, formatFolderTree } from "./folders.js";

const KANBAN = new URL("./kanban.js", import.meta.url).pathname;

interface Folder { _id: string; name: string; parentId?: string; rank: number }
interface Project { _id: string; key: string; name: string; organizationId?: string; folderId?: string; folderRank?: number }

/** The default workspace "acme" (id o1): folders Clients > Acme Corp, and Ops; WEB filed in Clients, OPS unfiled. */
const FOLDERS: Folder[] = [
  { _id: "f1", name: "Clients", rank: 1 },
  { _id: "f2", name: "Acme Corp", parentId: "f1", rank: 2 },
  { _id: "f3", name: "Ops", rank: 3 },
];
const PROJECTS: Project[] = [
  { _id: "p1", key: "WEB", name: "Web", organizationId: "o1", folderId: "f1", folderRank: 1 },
  { _id: "p2", key: "OPS", name: "Ops Tools", organizationId: "o1" },
];

interface FakeOptions { folders?: Folder[]; projects?: Project[] }

/** Fake Convex client: answers the reads these commands need and records every mutation. */
function fakeClient(options: FakeOptions = {}) {
  const folders = options.folders ?? FOLDERS;
  const projects = options.projects ?? PROJECTS;
  const mutations: { name: string; args: any }[] = [];
  const client = {
    async query(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      switch (name) {
        case "preferences:getCliDefaults": return { workspaceSlug: null, projectKey: null };
        case "organizations:getBySlug": return args.slug === "acme" ? { id: "o1", name: "Acme", slug: "acme", plan: "pro", role: "owner" } : null;
        case "organizations:listMine": return [{ _id: "o1", slug: "acme" }];
        case "projects:list": return projects.map((p) => ({ ...p, folderName: folders.find((f) => f._id === p.folderId)?.name ?? null }));
        case "projects:getByKey": return projects.find((p) => p.key === args.key) ?? null;
        case "projectFolders:listOrganized": return { folders, projects };
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

/** The exit code the executable would use for a thrown error: usage errors are 2. */
function exitCode(e: unknown): number | undefined {
  if (e instanceof UsageError) return 2;
  return (e as { code?: number } | undefined)?.code;
}

/** The error a run throws, or undefined when it succeeds. */
async function failure(argv: string[], client: CliConvexClient): Promise<Error | undefined> {
  try {
    await run(argv, client);
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

let configDir: string;
const saved = { KANBAN_CONFIG_FILE: process.env.KANBAN_CONFIG_FILE, KANBAN_PROJECT: process.env.KANBAN_PROJECT, KANBAN_WORKSPACE: process.env.KANBAN_WORKSPACE, KANBAN_USER: process.env.KANBAN_USER };

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "kanban-folders-"));
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

describe("findFolder (name or id)", () => {
  it("matches an id exactly", () => {
    const hit = findFolder(FOLDERS, "f3");
    assert.deepEqual(hit, { kind: "one", folder: FOLDERS[2] });
  });

  it("matches a name case-insensitively", () => {
    assert.deepEqual(findFolder(FOLDERS, "acme corp"), { kind: "one", folder: FOLDERS[1] });
  });

  it("reports no match for an unknown reference", () => {
    assert.deepEqual(findFolder(FOLDERS, "Nope"), { kind: "none" });
  });

  it("reports every match when a name is ambiguous", () => {
    const twoOps = [...FOLDERS, { _id: "f4", name: "ops", rank: 4 }];
    const hit = findFolder(twoOps, "OPS");
    assert.equal(hit.kind, "many");
    assert.deepEqual(hit.kind === "many" ? hit.matches.map((f) => f._id) : [], ["f3", "f4"]);
  });

  it("prefers an id over a name that happens to equal it", () => {
    const folders = [{ _id: "f9", name: "f1", rank: 1 }, ...FOLDERS];
    assert.deepEqual(findFolder(folders, "f1"), { kind: "one", folder: FOLDERS[0] });
  });
});

describe("formatFolderTree", () => {
  it("indents child folders and each folder's projects; unfiled projects go last", () => {
    assert.equal(formatFolderTree(FOLDERS, PROJECTS), [
      "Clients",
      "  Acme Corp",
      "  WEB  Web",
      "Ops",
      "Top level",
      "  OPS  Ops Tools",
    ].join("\n"));
  });

  it("says so when the workspace has no folders", () => {
    assert.equal(formatFolderTree([], [PROJECTS[1]]), "Top level\n  OPS  Ops Tools");
  });
});

describe("kanban projects list shows folders", () => {
  it("adds a FOLDER column, with - for projects at the top level", async () => {
    const { client } = fakeClient();
    const lines = (await run(["projects", "list", "--workspace", "acme"], client)).split("\n");
    assert.match(lines[0], /^KEY\s+NAME\s+FOLDER$/);
    assert.match(lines.find((l) => l.startsWith("WEB"))!, /Clients$/);
    assert.match(lines.find((l) => l.startsWith("OPS"))!, /-$/);
  });

  it("JSON carries folderName and folderId, null at the top level", async () => {
    const { client } = fakeClient();
    const rows = JSON.parse(await run(["projects", "list", "--workspace", "acme", "--json"], client));
    const web = rows.find((r: { key: string }) => r.key === "WEB");
    const ops = rows.find((r: { key: string }) => r.key === "OPS");
    assert.deepEqual([web.folderName, web.folderId], ["Clients", "f1"]);
    assert.deepEqual([ops.folderName, ops.folderId], [null, null]);
  });
});

describe("kanban folders list", () => {
  it("prints the folder tree for the workspace", async () => {
    const { client } = fakeClient();
    assert.equal(await run(["folders", "list", "--workspace", "acme"], client), formatFolderTree(FOLDERS, PROJECTS));
  });

  it("needs a workspace, and says how to choose one", async () => {
    const { client } = fakeClient();
    const error = await failure(["folders", "list"], client);
    assert.equal(exitCode(error), 2, error?.message);
    assert.match(error?.message ?? "", /--workspace SLUG/);
  });

  it("an unknown workspace is not found", async () => {
    const { client } = fakeClient();
    const error = await failure(["folders", "list", "--workspace", "nope"], client);
    assert.match(error?.message ?? "", /Workspace nope not found/);
  });
});

describe("kanban folders create / rename / delete", () => {
  it("create sends the name to createFolder", async () => {
    const { client, mutations } = fakeClient();
    await run(["folders", "create", "Sales", "--workspace", "acme", "--json"], client);
    assert.deepEqual(mutations, [{ name: "projectFolders:createFolder", args: { organizationId: "o1", name: "Sales" } }]);
  });

  it("create --parent resolves a folder by name and sends its id as parentId", async () => {
    const { client, mutations } = fakeClient();
    await run(["folders", "create", "Sales", "--parent", "ops", "--workspace", "acme", "--json"], client);
    assert.deepEqual(mutations[0].args, { organizationId: "o1", name: "Sales", parentId: "f3" });
  });

  it("rename sends the resolved folder id and the new name", async () => {
    const { client, mutations } = fakeClient();
    await run(["folders", "rename", "Ops", "--name", "Operations", "--workspace", "acme", "--json"], client);
    assert.deepEqual(mutations, [{ name: "projectFolders:renameFolder", args: { folderId: "f3", name: "Operations" } }]);
  });

  it("rename without --name is a usage error and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    const error = await failure(["folders", "rename", "Ops", "--workspace", "acme"], client);
    assert.equal(exitCode(error), 2, error?.message);
    assert.equal(mutations.length, 0);
  });

  it("delete without --yes refuses and says the projects move to the top level", async () => {
    const { client, mutations } = fakeClient();
    const error = await failure(["folders", "delete", "Clients", "--workspace", "acme"], client);
    assert.equal(exitCode(error), 2, error?.message);
    assert.match(error?.message ?? "", /Its projects move to the top level/);
    assert.equal(mutations.length, 0);
  });

  it("delete --yes sends deleteFolder with the resolved id", async () => {
    const { client, mutations } = fakeClient();
    await run(["folders", "delete", "f1", "--yes", "--workspace", "acme", "--json"], client);
    assert.deepEqual(mutations, [{ name: "projectFolders:deleteFolder", args: { folderId: "f1" } }]);
  });

  it("delete without --yes exits 2 before touching the server", () => {
    const result = spawnSync(process.execPath, [KANBAN, "folders", "delete", "Clients"], {
      encoding: "utf8",
      // A loopback URL is accepted without network discovery, so this never reaches production.
      env: { ...process.env, KANBAN_CONFIG_FILE: join(configDir, "exit-config.json"), KANBAN_URL: "http://127.0.0.1:9", KANBAN_NO_UPDATE_CHECK: "1" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Its projects move to the top level/);
  });

  it("an unknown folder is not found and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    const error = await failure(["folders", "rename", "Nope", "--name", "X", "--workspace", "acme"], client);
    assert.match(error?.message ?? "", /Folder "Nope" not found/);
    assert.equal(mutations.length, 0);
  });

  it("an ambiguous folder name exits 2 and lists the matches, sending nothing", async () => {
    const { client, mutations } = fakeClient({ folders: [...FOLDERS, { _id: "f4", name: "Ops", rank: 4 }] });
    const error = await failure(["folders", "rename", "Ops", "--name", "X", "--workspace", "acme"], client);
    assert.equal(exitCode(error), 2, error?.message);
    assert.match(error?.message ?? "", /ambiguous/i);
    assert.match(error?.message ?? "", /f3/);
    assert.match(error?.message ?? "", /f4/);
    assert.equal(mutations.length, 0);
  });

  it("--dry-run on each folder write sends nothing and reports the change", async () => {
    const { client, mutations } = fakeClient();
    const create = JSON.parse(await run(["folders", "create", "Sales", "--workspace", "acme", "--dry-run", "--json"], client));
    assert.deepEqual(create.wouldChange, [{ action: "folders.create", keys: [], fields: { name: "Sales" } }]);
    const rename = JSON.parse(await run(["folders", "rename", "Ops", "--name", "Operations", "--workspace", "acme", "--dry-run", "--json"], client));
    assert.deepEqual(rename.wouldChange, [{ action: "folders.rename", keys: [], fields: { folder: "Ops", name: "Operations" } }]);
    const del = JSON.parse(await run(["folders", "delete", "Clients", "--yes", "--workspace", "acme", "--dry-run", "--json"], client));
    assert.deepEqual(del.wouldChange, [{ action: "folders.delete", keys: [], fields: { folder: "Clients" } }]);
    assert.equal(mutations.length, 0);
  });
});

describe("kanban projects move KEY --folder", () => {
  it("files a project in a folder by name", async () => {
    const { client, mutations } = fakeClient();
    await run(["projects", "move", "OPS", "--folder", "Clients", "--json"], client);
    assert.deepEqual(mutations, [{ name: "projectFolders:moveProject", args: { projectId: "p2", folderId: "f1" } }]);
  });

  it("--folder none moves the project to the top level", async () => {
    const { client, mutations } = fakeClient();
    await run(["projects", "move", "WEB", "--folder", "none", "--json"], client);
    assert.deepEqual(mutations, [{ name: "projectFolders:moveProject", args: { projectId: "p1", folderId: null } }]);
  });

  it("needs --folder", async () => {
    const { client, mutations } = fakeClient();
    const error = await failure(["projects", "move", "WEB"], client);
    assert.equal(exitCode(error), 2, error?.message);
    assert.equal(mutations.length, 0);
  });

  it("an unknown folder is not found and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    const error = await failure(["projects", "move", "WEB", "--folder", "Nope"], client);
    assert.match(error?.message ?? "", /Folder "Nope" not found/);
    assert.equal(mutations.length, 0);
  });

  it("--dry-run reports the move and sends nothing", async () => {
    const { client, mutations } = fakeClient();
    const printed = JSON.parse(await run(["projects", "move", "WEB", "--folder", "none", "--dry-run", "--json"], client));
    assert.deepEqual(printed.wouldChange, [{ action: "projects.move", keys: ["WEB"], fields: { folder: "none" } }]);
    assert.equal(mutations.length, 0);
  });
});
