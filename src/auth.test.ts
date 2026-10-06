import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { browserLogin, readAuth } from "./auth.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempAuthFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kanban-cli-auth-"));
  tempDirs.push(directory);
  return join(directory, "config", "auth.json");
}

test("browser login validates callback state and stores credentials with owner-only permissions", async () => {
  const file = await tempAuthFile();
  const login = await new Promise<string>((resolve, reject) => {
    void browserLogin("https://kanban.example", { file, open: resolve, timeoutMs: 5_000 }).catch(reject);
  });
  const loginUrl = new URL(login);
  const callback = loginUrl.searchParams.get("callback");
  const state = loginUrl.searchParams.get("state");
  assert.ok(callback);
  assert.ok(state);

  const invalid = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://kanban.example" },
    body: new URLSearchParams({ state: "wrong", token: "x".repeat(40) }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(await readAuth(file), null);

  const token = "jwt-test-".padEnd(40, "x");
  const accepted = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://kanban.example" },
    body: new URLSearchParams({ state, token }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await readAuth(file), { token, site: "https://kanban.example" });
  assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("browser login rejects a mismatched origin and insecure remote site", async () => {
  const file = await tempAuthFile();
  let opened = "";
  const login = browserLogin("https://kanban.example", { file, open: (url) => { opened = url; }, timeoutMs: 100 });
  while (!opened) await new Promise((resolve) => setTimeout(resolve, 5));
  const url = new URL(opened);
  const callback = url.searchParams.get("callback")!;
  const response = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://attacker.example" },
    body: new URLSearchParams({ state: url.searchParams.get("state")!, token: "x".repeat(40) }),
  });
  assert.equal(response.status, 403);
  await assert.rejects(login, /Sign-in timed out/);
  assert.equal(await readFile(file, "utf8").then(() => true, () => false), false);
  await assert.rejects(browserLogin("http://kanban.example", { file, open: () => { throw new Error("must not open"); } }), /requires HTTPS/);
});
