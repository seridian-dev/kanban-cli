import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkedContext, linkedProject, readConfig, writeConfig } from "./config.js";

test("local project links resolve the most specific parent folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-cli-config-"));
  const file = join(dir, "config.json");
  const previous = process.env.KANBAN_CONFIG_FILE;
  process.env.KANBAN_CONFIG_FILE = file;
  try {
    await writeConfig({ site: "https://kanban.seridian.dev", project: "WEB", links: [
      { path: "/work", project: "WEB" },
      { path: "/work/tools", project: "OPS", workspace: "Acme" },
    ] });
    const config = await readConfig();
    assert.equal(linkedProject(config, "/work/app/src"), "WEB");
    assert.equal(linkedProject(config, "/work/tools/cli/src"), "OPS");
    assert.deepEqual(linkedContext(config, "/work/tools/cli/src"), { path: "/work/tools", project: "OPS", workspace: "acme" });
    assert.equal(linkedProject(config, "/other"), undefined);
    assert.equal((await readFile(file, "utf8")).includes("WEB"), true);
  } finally {
    if (previous === undefined) delete process.env.KANBAN_CONFIG_FILE;
    else process.env.KANBAN_CONFIG_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved config is written with owner-only permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-cli-mode-"));
  const file = join(dir, "config.json");
  const previous = process.env.KANBAN_CONFIG_FILE;
  process.env.KANBAN_CONFIG_FILE = file;
  try {
    await writeConfig({ user: "Alex", project: "web" });
    assert.equal((await readConfig()).project, "WEB");
    const { mode } = await (await import("node:fs/promises")).stat(file);
    assert.equal(mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.KANBAN_CONFIG_FILE;
    else process.env.KANBAN_CONFIG_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseGithubRemote reads https and ssh remotes", async () => {
  const { parseGithubRemote } = await import("./config.js");
  assert.equal(parseGithubRemote("https://github.com/4cecoder/propertyportal.git"), "4cecoder/propertyportal");
  assert.equal(parseGithubRemote("git@github.com:seridian-dev/kanban-cli.git\n"), "seridian-dev/kanban-cli");
  assert.equal(parseGithubRemote("https://gitlab.com/a/b.git"), undefined);
});
