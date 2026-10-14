import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { browserLogin, challengeFor, codeLogin, createVerifier, detectLoginMode, hasLocalDisplay, normalizeCode, readAuth, selectLoginMode } from "./auth.js";

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

async function startLogin(file: string): Promise<{ callback: string; state: string }> {
  let opened = "";
  const login = browserLogin("https://kanban.example", { file, open: (url) => { opened = url; }, timeoutMs: 5_000 });
  while (!opened) await new Promise((resolve) => setTimeout(resolve, 5));
  const url = new URL(opened);
  void login.catch(() => {});
  return { callback: url.searchParams.get("callback")!, state: url.searchParams.get("state")! };
}

test("callback success page closes itself, names the machine, and is locked down", async () => {
  const file = await tempAuthFile();
  const { callback, state } = await startLogin(file);
  const token = "jwt-test-".padEnd(40, "x");
  const response = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://kanban.example" },
    body: new URLSearchParams({ state, token }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  const body = await response.text();
  assert.ok(body.includes("Signed in to the Kanban CLI. You can close this tab."));
  assert.ok(body.includes("window.close()"));
  assert.ok(body.includes("kept this tab open"));
  assert.ok(body.includes(hostname()), "page names the machine");
  assert.ok(!body.includes(token), "page must not contain the token");
});

test("state mismatch response stays a plain 400 with no close script", async () => {
  const file = await tempAuthFile();
  const { callback } = await startLogin(file);
  const response = await fetch(callback, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://kanban.example" },
    body: new URLSearchParams({ state: "wrong", token: "x".repeat(40) }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(await response.text(), "Sign-in check failed. Close this tab and run kanban login again.");
});

test("login mode detection uses code mode over SSH and on Linux without a display", () => {
  const cases: { name: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; mode: "code" | "browser" }[] = [
    { name: "ssh connection on macOS", env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" }, platform: "darwin", mode: "code" },
    { name: "ssh tty on Linux with a display", env: { SSH_TTY: "/dev/pts/1", DISPLAY: ":0" }, platform: "linux", mode: "code" },
    { name: "headless Linux", env: {}, platform: "linux", mode: "code" },
    { name: "Linux with empty display variables", env: { DISPLAY: "", WAYLAND_DISPLAY: "" }, platform: "linux", mode: "code" },
    { name: "Linux with X11", env: { DISPLAY: ":0" }, platform: "linux", mode: "browser" },
    { name: "Linux with Wayland", env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", mode: "browser" },
    { name: "local macOS", env: {}, platform: "darwin", mode: "browser" },
    { name: "local Windows", env: {}, platform: "win32", mode: "browser" },
  ];
  for (const c of cases) {
    assert.equal(detectLoginMode(c.env, c.platform), c.mode, c.name);
    assert.equal(hasLocalDisplay(c.env, c.platform), c.mode === "browser", c.name);
  }
});

test("--code, --no-browser and --browser override detection", () => {
  const desktop = { env: { DISPLAY: ":0" }, platform: "linux" as const };
  const headless = { env: {}, platform: "linux" as const };
  assert.equal(selectLoginMode({}, desktop.env, desktop.platform), "browser");
  assert.equal(selectLoginMode({}, headless.env, headless.platform), "code");
  assert.equal(selectLoginMode({ code: true }, desktop.env, desktop.platform), "code");
  assert.equal(selectLoginMode({ noBrowser: true }, desktop.env, desktop.platform), "code");
  assert.equal(selectLoginMode({ browser: true }, headless.env, headless.platform), "browser");
  assert.throws(() => selectLoginMode({ code: true, browser: true }, desktop.env, desktop.platform), /either --code or --browser/);
});

test("challenge is base64url(sha256(verifier)) without padding", () => {
  // Fixed vector computed independently with Python: urlsafe_b64encode(sha256(v)).rstrip("=").
  assert.equal(challengeFor("dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW1gFWFOEjXk"), "ngF5GsXcbwljx6u133FFr3Xht9xooA_DuaX_3QwODtc");
  const verifier = createVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createVerifier(), verifier);
  const expected = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(challengeFor(verifier), expected);
  assert.match(challengeFor(verifier), /^[A-Za-z0-9_-]{43}$/);
});

test("code input is trimmed, uppercased, and stripped of spaces and dashes", () => {
  assert.equal(normalizeCode("  kj7q-m2xp \n"), "KJ7QM2XP");
  assert.equal(normalizeCode("KJ7Q M2XP"), "KJ7QM2XP");
  assert.equal(normalizeCode("k j7q--m2 xp"), "KJ7QM2XP");
});

const TOKEN = "jwt-code-".padEnd(40, "x");

function codeHarness(answers: string[], redeem: (args: { code: string; verifier: string }) => Promise<unknown>) {
  const lines: string[] = [];
  const prompts: string[] = [];
  const calls: { code: string; verifier: string }[] = [];
  const opened: string[] = [];
  return {
    lines, prompts, calls, opened,
    options: {
      isTTY: true,
      log: (line: string) => { lines.push(line); },
      open: (url: string) => { opened.push(url); },
      prompt: async (question: string) => {
        prompts.push(question);
        const answer = answers.shift();
        if (answer === undefined) throw new Error("prompted too many times");
        return answer;
      },
      redeem: async (args: { code: string; verifier: string }) => { calls.push(args); return redeem(args); },
    },
  };
}

test("code login prints the URL, redeems the normalized code, and saves the token", async () => {
  const file = await tempAuthFile();
  const h = codeHarness([" kj7q-m2xp "], async () => ({ token: TOKEN }));
  await codeLogin("https://kanban.example", { ...h.options, file });

  const output = h.lines.join("\n");
  const url = /^https:\/\/kanban\.example\/cli\/login\?\S+$/m.exec(output)?.[0];
  assert.ok(url, `output names the login URL:\n${output}`);
  assert.ok(output.startsWith("Open this URL on any device, sign in and choose ‘Authorize CLI’:\n" + url + "\nThen type the code it shows here."));
  const loginUrl = new URL(url);
  assert.equal(loginUrl.searchParams.get("mode"), "code");
  assert.equal(loginUrl.searchParams.get("callback"), null);
  assert.deepEqual(h.opened, [url]);
  assert.deepEqual(h.prompts, ["Code: "]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].code, "KJ7QM2XP");
  assert.match(h.calls[0].verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loginUrl.searchParams.get("challenge"), challengeFor(h.calls[0].verifier));
  assert.ok(!output.includes(h.calls[0].verifier), "the verifier never leaves this machine");

  assert.deepEqual(await readAuth(file), { token: TOKEN, site: "https://kanban.example" });
  assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(output, /Signed in\. Your Kanban access token is stored in ~\/\.config\/kanban\/auth\.json with owner-only permissions\./);
});

test("code login retries an invalid or expired code, then succeeds", async () => {
  const file = await tempAuthFile();
  let attempt = 0;
  const h = codeHarness(["AAAA-AAAA", "BBBB-BBBB", "KJ7Q-M2XP"], async () => {
    attempt += 1;
    if (attempt < 3) throw new Error("[CONVEX M(cliLogin:redeemCode)] Uncaught Error: Code is invalid or expired");
    return { token: TOKEN };
  });
  await codeLogin("https://kanban.example", { ...h.options, file });
  assert.equal(h.prompts.length, 3);
  assert.deepEqual(h.calls.map((c) => c.code), ["AAAAAAAA", "BBBBBBBB", "KJ7QM2XP"]);
  assert.equal(new Set(h.calls.map((c) => c.verifier)).size, 1, "every attempt uses the same verifier");
  assert.ok(h.lines.some((line) => /invalid or expired.*2 attempts left/i.test(line)));
  assert.deepEqual(await readAuth(file), { token: TOKEN, site: "https://kanban.example" });
});

test("code login gives up after three invalid or expired codes", async () => {
  const file = await tempAuthFile();
  const h = codeHarness(["A", "B", "C", "D"], async () => { throw Object.assign(new Error("Server Error"), { data: "invalid or expired code" }); });
  await assert.rejects(codeLogin("https://kanban.example", { ...h.options, file }), /invalid or expired.*kanban login --code/i);
  assert.equal(h.prompts.length, 3);
  assert.equal(h.calls.length, 3);
  assert.equal(await readAuth(file), null);
});

test("code login does not retry other errors or a bad response", async () => {
  const file = await tempAuthFile();
  const failing = codeHarness(["KJ7Q-M2XP", "KJ7Q-M2XP"], async () => { throw new Error("fetch failed"); });
  await assert.rejects(codeLogin("https://kanban.example", { ...failing.options, file }), /fetch failed/);
  assert.equal(failing.prompts.length, 1);
  const malformed = codeHarness(["KJ7Q-M2XP"], async () => ({ token: 42 }));
  await assert.rejects(codeLogin("https://kanban.example", { ...malformed.options, file }), /did not return a valid token/);
  assert.equal(await readAuth(file), null);
});

test("code login without a TTY fails before prompting", async () => {
  const file = await tempAuthFile();
  const h = codeHarness(["KJ7Q-M2XP"], async () => ({ token: TOKEN }));
  await assert.rejects(codeLogin("https://kanban.example", { ...h.options, isTTY: false, file }), /interactive terminal/);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.opened, []);
  await assert.rejects(codeLogin("http://kanban.example", { ...h.options, file }), /requires HTTPS/);
});

test("kanban login --code with piped stdin exits with a clear message", async () => {
  const home = await mkdtemp(join(tmpdir(), "kanban-cli-home-"));
  tempDirs.push(home);
  const kanban = new URL("./kanban.js", import.meta.url).pathname;
  for (const flag of ["--code", "--no-browser"]) {
    const run = spawnSync(process.execPath, [kanban, "login", flag], { encoding: "utf8", input: "", env: { ...process.env, HOME: home, KANBAN_NO_UPDATE_CHECK: "1" } });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /interactive terminal/);
    assert.doesNotMatch(run.stdout, /cli\/login/);
  }
  const both = spawnSync(process.execPath, [kanban, "login", "--code", "--browser"], { encoding: "utf8", input: "", env: { ...process.env, HOME: home } });
  assert.equal(both.status, 2);
  assert.match(both.stderr, /either --code or --browser/);
  const extra = spawnSync(process.execPath, [kanban, "login", "--code", "KJ7Q-M2XP"], { encoding: "utf8", input: "", env: { ...process.env, HOME: home } });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /type the code when asked/);
});
