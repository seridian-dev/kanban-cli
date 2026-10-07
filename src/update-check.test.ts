import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSemver, checkForUpdate, shouldShowUpdateNotice } from "./update-check.js";

const tempDirs: string[] = [];
const originalConfigFile = process.env.KANBAN_CONFIG_FILE;
afterEach(async () => {
  if (originalConfigFile === undefined) delete process.env.KANBAN_CONFIG_FILE;
  else process.env.KANBAN_CONFIG_FILE = originalConfigFile;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function configPath() {
  const dir = await mkdtemp(join(tmpdir(), "kanban-update-test-")); tempDirs.push(dir);
  process.env.KANBAN_CONFIG_FILE = join(dir, "config.json");
}

test("semver comparison respects core and prerelease ordering", () => {
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0+one", "1.0.0+two"), 0);
});

test("check caches the latest version for 24 hours", async () => {
  await configPath();
  let requests = 0;
  const fetcher = (async () => { requests++; return Response.json({ version: "99.0.0" }); }) as typeof fetch;
  const first = await checkForUpdate({ fetcher, now: 1_000_000 });
  const second = await checkForUpdate({ fetcher, now: 1_000_000 + 23 * 60 * 60 * 1000 });
  assert.equal(first.updateAvailable, true);
  assert.equal(second.latest, "99.0.0");
  assert.equal(requests, 1);
  const cache = JSON.parse(await readFile(join(tempDirs[0]!, "update-check.json"), "utf8"));
  assert.equal(cache.checkedAt, 1_000_000);
});

test("forced check bypasses the 24 hour cache", async () => {
  await configPath();
  let requests = 0;
  const fetcher = (async () => { requests++; return Response.json({ version: "0.1.2" }); }) as typeof fetch;
  await checkForUpdate({ fetcher, now: 1_000_000 });
  await checkForUpdate({ fetcher, now: 1_000_001, force: true });
  assert.equal(requests, 2);
});

test("network errors reject for the caller to silently ignore", async () => {
  await configPath();
  await assert.rejects(checkForUpdate({ fetcher: (async () => { throw new Error("offline"); }) as typeof fetch }), /offline/);
});

test("automatic notice is suppressed for JSON, opt-out, CI, and agent-help", () => {
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list", "--json"] }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list"], env: { KANBAN_NO_UPDATE_CHECK: "1" } }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list"], env: { CI: "true" } }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["agent-help"] }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: false, command: ["items", "list"] }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list"] }), true);
});
