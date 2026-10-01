import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkedProject, readConfig, writeConfig } from "./config.js";

test("local project links resolve the most specific parent folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-cli-config-"));
  const file = join(dir, "config.json");
  const previous = process.env.KANBAN_CONFIG_FILE;
  process.env.KANBAN_CONFIG_FILE = file;
  try {
    await writeConfig({ site: "https://kanban.seridian.dev", project: "KAN", links: [
      { path: "/work", project: "KAN" },
      { path: "/work/tools", project: "OPS" },
    ] });
    const config = await readConfig();
    assert.equal(linkedProject(config, "/work/app/src"), "KAN");
    assert.equal(linkedProject(config, "/work/tools/cli/src"), "OPS");
    assert.equal(linkedProject(config, "/other"), undefined);
    assert.equal((await readFile(file, "utf8")).includes("KAN"), true);
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
    await writeConfig({ user: "Dee", project: "kan" });
    assert.equal((await readConfig()).project, "KAN");
    const { mode } = await (await import("node:fs/promises")).stat(file);
    assert.equal(mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.KANBAN_CONFIG_FILE;
    else process.env.KANBAN_CONFIG_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
