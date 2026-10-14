import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autoUpdate, autoUpdateHint, CHECK_TIMEOUT_MS, compareSemver, checkForUpdate, isGlobalInstall, isUnderNpx, shouldAutoUpdate, shouldShowUpdateNotice } from "./update-check.js";

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
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list"], env: { KANBAN_NO_UPDATE: "1" } }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list"], env: { CI: "true" } }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["agent-help"] }), false);
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: false, command: ["items", "list"] }), false);
  // Pass an explicit env so the positive case does not depend on the runner's CI variable.
  assert.equal(shouldShowUpdateNotice({ stdoutIsTTY: true, command: ["items", "list"], env: {} }), true);
});

test("the registry check aborts after 2 seconds", () => {
  assert.equal(CHECK_TIMEOUT_MS, 2000);
});

test("auto-update runs for a plain TTY command and skips when CI=true", () => {
  assert.equal(shouldAutoUpdate({ argv: ["items", "list"], env: {}, stdoutIsTTY: true }), true);
  assert.equal(shouldAutoUpdate({ argv: ["items", "list"], env: { CI: "true" }, stdoutIsTTY: true }), false);
});

test("auto-update skips when KANBAN_NO_UPDATE=1", () => {
  assert.equal(shouldAutoUpdate({ argv: ["items", "list"], env: { KANBAN_NO_UPDATE: "1" }, stdoutIsTTY: true }), false);
});

test("auto-update skips --json off-TTY but allows --json on a TTY", () => {
  assert.equal(shouldAutoUpdate({ argv: ["items", "list", "--json"], env: {}, stdoutIsTTY: false }), false);
  assert.equal(shouldAutoUpdate({ argv: ["items", "list", "--json"], env: {}, stdoutIsTTY: true }), true);
});

test("auto-update skips offline-first commands and kanban update check", () => {
  for (const argv of [["help"], ["agent-help"], ["schema"], ["update", "check"]]) {
    assert.equal(shouldAutoUpdate({ argv, env: {}, stdoutIsTTY: true }), false, argv.join(" "));
  }
});

test("npx detection sees npm's exec lifecycle and the _npx cache path", async () => {
  assert.equal(isUnderNpx({ env: { npm_command: "exec" } }), true);
  assert.equal(isUnderNpx({ env: { npm_execpath: "/usr/local/lib/node_modules/npm/bin/npx-cli.js" } }), true);
  const dir = await mkdtemp(join(tmpdir(), "kanban-npx-test-")); tempDirs.push(dir);
  const script = join(dir, "kanban.js");
  await writeFile(script, "export {}\n");
  assert.equal(isUnderNpx({ script, env: {} }), false);
  await mkdir(join(dir, "_npx"));
  const cached = join(dir, "_npx", "kanban.js");
  await writeFile(cached, "export {}\n");
  assert.equal(isUnderNpx({ script: cached, env: {} }), true);
});

test("global install detection follows the npm prefix layout and rejects project and npx installs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-global-test-")); tempDirs.push(dir);
  const globalScript = join(dir, "lib", "node_modules", "@seridian", "kanban-cli", "dist", "kanban.js");
  await mkdir(dirname(globalScript), { recursive: true });
  await writeFile(globalScript, "export {}\n");
  const localScript = join(dir, "project", "node_modules", "@seridian", "kanban-cli", "dist", "kanban.js");
  await mkdir(dirname(localScript), { recursive: true });
  await writeFile(localScript, "export {}\n");
  assert.equal(isGlobalInstall({ script: globalScript, prefix: dir }), true);
  assert.equal(isGlobalInstall({ script: localScript, prefix: dir }), false);
  assert.equal(isGlobalInstall({ script: globalScript, prefix: join(dir, "no-such-prefix") }), false);
  assert.equal(isGlobalInstall({ script: join(dir, "missing.js"), prefix: dir }), false);
});

test("auto-update does not touch the registry when a skip rule matches", async () => {
  await configPath();
  let requests = 0;
  const fetcher = (async () => { requests++; return Response.json({ version: "99.0.0" }); }) as typeof fetch;
  const outcome = await autoUpdate({ argv: ["items", "list"], env: { CI: "true" }, stdoutIsTTY: true, fetcher, globalInstall: true });
  assert.deepEqual(outcome, { action: "continue" });
  assert.equal(requests, 0);
});

test("auto-update continues without installing when the CLI is current", async () => {
  await configPath();
  let installs = 0;
  const outcome = await autoUpdate({
    argv: ["items", "list"], env: {}, stdoutIsTTY: true, now: 1_000_000,
    fetcher: (async () => Response.json({ version: "0.3.2" })) as typeof fetch,
    globalInstall: true,
    installer: () => { installs++; return { status: 0 }; },
  });
  assert.deepEqual(outcome, { action: "continue" });
  assert.equal(installs, 0);
});

test("auto-update leaves non-global installs to the post-run notice", async () => {
  await configPath();
  let installs = 0;
  const outcome = await autoUpdate({
    argv: ["items", "list"], env: {}, stdoutIsTTY: true, now: 1_000_000,
    fetcher: (async () => Response.json({ version: "99.0.0" })) as typeof fetch,
    globalInstall: false,
    installer: () => { installs++; return { status: 0 }; },
  });
  assert.deepEqual(outcome, { action: "continue" });
  assert.equal(installs, 0);
});

test("auto-update installs the new version and re-runs the command when installed globally", async () => {
  await configPath();
  let installedAt: string | undefined;
  let reexeced = false;
  const lines: string[] = [];
  const outcome = await autoUpdate({
    argv: ["items", "list"], env: {}, stdoutIsTTY: true, now: 1_000_000,
    fetcher: (async () => Response.json({ version: "99.0.0" })) as typeof fetch,
    globalInstall: true,
    installer: (latest) => { installedAt = latest; return { status: 0 }; },
    reexec: () => { reexeced = true; return { status: 0 }; },
    warn: (line) => lines.push(line),
  });
  assert.deepEqual(outcome, { action: "rerun", status: 0 });
  assert.equal(installedAt, "99.0.0");
  assert.equal(reexeced, true);
  assert.deepEqual(lines, ["Updated @seridian/kanban-cli to 99.0.0; re-running with the new version."]);
});

test("auto-update prints one hint and continues when the check fails", async () => {
  await configPath();
  const hints: string[] = [];
  const outcome = await autoUpdate({
    argv: ["items", "list"], env: {}, stdoutIsTTY: true, now: 1_000_000,
    fetcher: (async () => { throw new Error("offline"); }) as typeof fetch,
    globalInstall: true,
    warn: (line) => hints.push(line),
  });
  assert.deepEqual(outcome, { action: "continue" });
  assert.equal(hints.length, 1);
  assert.match(hints[0]!, /Could not auto-update @seridian\/kanban-cli/);
  assert.match(hints[0]!, /npm i -g @seridian\/kanban-cli/);
});

test("auto-update prints one hint and continues when the installer fails", async () => {
  await configPath();
  const hints: string[] = [];
  let reexeced = false;
  const outcome = await autoUpdate({
    argv: ["items", "list"], env: {}, stdoutIsTTY: true, now: 1_000_000,
    fetcher: (async () => Response.json({ version: "99.0.0" })) as typeof fetch,
    globalInstall: true,
    installer: () => ({ status: 1 }),
    reexec: () => { reexeced = true; return { status: 0 }; },
    warn: (line) => hints.push(line),
  });
  assert.deepEqual(outcome, { action: "continue" });
  assert.equal(reexeced, false);
  assert.equal(hints.length, 1);
  assert.match(hints[0]!, /99\.0\.0/);
  assert.match(autoUpdateHint("99.0.0"), /to 99\.0\.0/);
});
