import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { resolveBackendUrl } from "./backend.js";
import { createHttpFetch } from "./http.js";
import { UsageError } from "./lib.js";

const authFile = join(homedir(), ".config", "kanban", "auth.json");
/** A code sign-in started without a terminal: the verifier waits here for `kanban login --code <CODE>`. */
const pendingLoginFile = join(homedir(), ".config", "kanban", "pending-login.json");
/** Matches the server's code lifetime; a pending sign-in is useless after it. */
const PENDING_LOGIN_TTL_MS = 5 * 60_000;
const MAX_CALLBACK_BYTES = 8 * 1024;
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SIGNED_IN_MESSAGE = "Signed in. Your Kanban access token is stored in ~/.config/kanban/auth.json with owner-only permissions. It expires after three days; run `kanban login` again to reconnect.";
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 4096;

export async function readAuth(file = authFile): Promise<{ token: string; site?: string } | null> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { token?: unknown; site?: unknown };
    return typeof data.token === "string" ? { token: data.token, site: typeof data.site === "string" ? data.site : undefined } : null;
  } catch { return null; }
}

export async function clearToken(file = authFile): Promise<void> { await rm(file, { force: true }); }

/** Writes JSON readable only by the owner, in a directory only the owner can enter. */
async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function saveToken(token: string, site: string, file = authFile): Promise<void> {
  await writePrivateJson(file, { token, site: new URL(site).origin, savedAt: new Date().toISOString() });
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

const SUCCESS_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

// Success page shown in the browser tab after "Authorize CLI". It contains no token.
// It tries to close itself; if the browser keeps the tab open, it says so.
export function successPage(machine: string, when: Date): string {
  const time = when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kanban CLI connected</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1d1d1b; --muted: #5f5f58; --accent: #2f6f4e; --card: #ffffff; --line: #e2e2dc; }
@media (prefers-color-scheme: dark) { :root { --bg: #161715; --fg: #f1f1ec; --muted: #a3a39a; --accent: #7fc29b; --card: #1f201d; --line: #33352f; } }
:root[data-theme="light"] { --bg: #f7f7f5; --fg: #1d1d1b; --muted: #5f5f58; --accent: #2f6f4e; --card: #ffffff; --line: #e2e2dc; }
:root[data-theme="dark"] { --bg: #161715; --fg: #f1f1ec; --muted: #a3a39a; --accent: #7fc29b; --card: #1f201d; --line: #33352f; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 32rem; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; box-sizing: border-box; }
.brand { font-weight: 700; color: var(--accent); letter-spacing: .02em; margin: 0 0 16px; }
h1 { font-size: 1.4rem; margin: 0 0 8px; }
p { margin: 8px 0; color: var(--muted); }
.meta { font-size: .9rem; }
#fallback[hidden] { display: none; }
</style>
</head>
<body>
<main>
<p class="brand">Kanban</p>
<h1>Signed in to the Kanban CLI. You can close this tab.</h1>
<p class="meta">Machine: <strong>${escapeHtml(machine)}</strong> · Signed in: ${escapeHtml(time)}</p>
<p id="fallback" hidden>Your browser kept this tab open — close it any time.</p>
</main>
<script>
setTimeout(function () { window.close(); }, 800);
setTimeout(function () { document.getElementById("fallback").hidden = false; }, 1500);
</script>
</body>
</html>`;
}

type LoginOptions = {
  file?: string;
  open?: (url: string) => void;
  timeoutMs?: number;
};

function loginSite(site: string): URL {
  let siteUrl: URL;
  try { siteUrl = new URL(site); }
  catch { throw new Error("Set the Kanban website URL, such as https://kanban.seridian.dev."); }
  if (siteUrl.protocol !== "https:" && !(siteUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(siteUrl.hostname))) {
    throw new Error("Kanban sign-in requires HTTPS for remote sites.");
  }
  return siteUrl;
}

export async function browserLogin(site: string, options: LoginOptions = {}): Promise<void> {
  const siteUrl = loginSite(site);

  const state = randomBytes(32).toString("hex");
  let finish!: () => void;
  let fail!: (error: Error) => void;
  let settled = false;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const done = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    if (error) fail(error); else finish();
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/callback" || !LOCAL_ADDRESSES.has(request.socket.remoteAddress ?? "")) {
      response.writeHead(404).end("Not found"); return;
    }
    const origin = request.headers.origin;
    if (origin !== siteUrl.origin) {
      response.writeHead(403).end("Origin not allowed"); return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      response.writeHead(415).end("Unsupported content type"); return;
    }
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > MAX_CALLBACK_BYTES) {
      response.writeHead(413).end("Request too large"); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_CALLBACK_BYTES) {
          response.writeHead(413).end("Request too large");
          request.destroy();
          return;
        }
        chunks.push(buffer);
      }
    } catch { return; }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const receivedState = form.get("state") ?? "";
    const token = form.get("token") ?? "";
    const a = Buffer.from(state), b = Buffer.from(receivedState);
    if (a.length !== b.length || !timingSafeEqual(a, b) || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Sign-in check failed. Close this tab and run kanban login again.");
      return;
    }
    try {
      await saveToken(token, siteUrl.origin, options.file);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": SUCCESS_CSP,
      });
      response.end(successPage(hostname(), new Date()));
      done();
    } catch (error) {
      response.writeHead(500, { "Cache-Control": "no-store" }).end("Could not save Kanban CLI credentials. Return to the terminal and try again.");
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const timer = setTimeout(() => done(new Error("Sign-in timed out. Run kanban login to try again.")), options.timeoutMs ?? 5 * 60_000);
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the local sign-in callback");
    const callback = `http://127.0.0.1:${address.port}/callback`;
    const login = new URL("/cli/login", siteUrl.origin);
    login.searchParams.set("callback", callback);
    login.searchParams.set("state", state);
    console.log("Opening Kanban in your browser. Sign in, then choose ‘Authorize CLI’.\nIf it does not open, visit:\n" + login.href);
    console.log("Signing in from another device? Run `kanban login --code`.");
    (options.open ?? openBrowser)(login.href);
    await completed;
    console.log(SIGNED_IN_MESSAGE);
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export type LoginMode = "code" | "browser";

const isSet = (value: string | undefined): boolean => value !== undefined && value !== "";

/**
 * Whether a browser opened by this process would appear in front of the user:
 * false over SSH, and false on Linux when neither X11 nor Wayland is available.
 */
export function hasLocalDisplay(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (isSet(env.SSH_CONNECTION) || isSet(env.SSH_TTY)) return false;
  if (platform === "linux" && !isSet(env.DISPLAY) && !isSet(env.WAYLAND_DISPLAY)) return false;
  return true;
}

/** Plain `kanban login`: the localhost callback only works when the browser runs on this machine. */
export function detectLoginMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): LoginMode {
  return hasLocalDisplay(env, platform) ? "browser" : "code";
}

/** Applies `--code` / `--no-browser` / `--browser` on top of detection. */
export function selectLoginMode(
  flags: { code?: boolean; noBrowser?: boolean; browser?: boolean },
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): LoginMode {
  const wantsCode = flags.code === true || flags.noBrowser === true;
  if (wantsCode && flags.browser === true) throw new UsageError("Use either --code or --browser, not both.");
  if (wantsCode) return "code";
  if (flags.browser === true) return "browser";
  return detectLoginMode(env, platform);
}

/** 32 random bytes as base64url (43 characters). It stays on this machine. */
export function createVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** base64url, without padding, of SHA-256(verifier). Sent to the web page; the server checks it on redeem. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** `kj7q-m2xp ` → `KJ7QM2XP`. */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]+/g, "");
}

export type RedeemCode = (args: { code: string; verifier: string }) => Promise<unknown>;

/** Calls the public Convex mutation `cliLogin:redeemCode` on the backend the site advertises. */
export function convexRedeemer(site: string): RedeemCode {
  const redeemCode = makeFunctionReference<"mutation", { code: string; verifier: string }, unknown>("cliLogin:redeemCode");
  // A redeem is a mutation, so it is sent once; the helper still tells "offline" from "server error".
  const fetcher = createHttpFetch({ retries: 0, probeUrl: site });
  let client: Promise<ConvexHttpClient> | undefined;
  return async (args) => {
    client ??= resolveBackendUrl(site, fetcher).then((url) => new ConvexHttpClient(url, { fetch: fetcher }));
    return (await client).mutation(redeemCode, args);
  };
}

/** Text of a Convex or plain error, including ConvexError data, for matching. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  else parts.push(String(error));
  if (typeof error === "object" && error !== null && "data" in error) {
    const data: unknown = error.data;
    if (typeof data === "string") parts.push(data);
  }
  return parts.join("\n");
}

const isInvalidOrExpired = (error: unknown): boolean => /invalid or expired/i.test(errorText(error));

function tokenFrom(result: unknown): string {
  const token = typeof result === "object" && result !== null && "token" in result ? result.token : undefined;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    throw new Error("Kanban did not return a valid token. Run `kanban login --code` to try again.");
  }
  return token;
}

/** Reads one line from the terminal. Rejects if stdin closes first (Ctrl-D). */
async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once("close", () => reject(new Error("Sign-in cancelled.")));
      rl.question(question).then(resolve, reject);
    });
  } finally {
    rl.close();
  }
}

type CodeLoginOptions = {
  file?: string;
  /** Where a sign-in started without a terminal keeps its verifier. */
  pendingFile?: string;
  now?: () => number;
  /** Whether stdin is an interactive terminal. Defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  redeem?: RedeemCode;
  /** Also opens the URL locally. Defaults to the system browser when a local display is available. */
  open?: (url: string) => void;
  log?: (line: string) => void;
  maxAttempts?: number;
};

/**
 * Paste-back sign-in for SSH and headless machines: the user approves on any device,
 * the page shows a one-time code, and this process redeems it with its secret verifier.
 */
export async function codeLogin(site: string, options: CodeLoginOptions = {}): Promise<void> {
  const siteUrl = loginSite(site);
  const log = options.log ?? ((line: string) => console.log(line));
  const interactive = options.isTTY ?? process.stdin.isTTY === true;
  const prompt = options.prompt ?? promptLine;
  const redeem = options.redeem ?? convexRedeemer(siteUrl.origin);
  const maxAttempts = options.maxAttempts ?? 3;

  const verifier = createVerifier();
  const login = new URL("/cli/login", siteUrl.origin);
  login.searchParams.set("mode", "code");
  login.searchParams.set("challenge", challengeFor(verifier));
  if (!interactive) {
    // No terminal to prompt (scripts, `!` in an agent, piped input): keep the verifier on
    // this machine and finish with a second command that takes the code as an argument.
    const now = options.now ?? Date.now;
    await writePrivateJson(options.pendingFile ?? pendingLoginFile, { site: siteUrl.origin, verifier, expiresAt: now() + PENDING_LOGIN_TTL_MS });
    log("Open this URL on any device, sign in and choose ‘Authorize CLI’:\n" + login.href + "\nThen run: kanban login --code <CODE>   (within 5 minutes, with the code the page shows)");
    return;
  }
  log("Open this URL on any device, sign in and choose ‘Authorize CLI’:\n" + login.href + "\nThen type the code it shows here.");
  const open = options.open ?? (hasLocalDisplay(process.env, process.platform) ? openBrowser : undefined);
  open?.(login.href);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const left = maxAttempts - attempt;
    const retryHint = `(${left} ${left === 1 ? "attempt" : "attempts"} left)`;
    const code = normalizeCode(await prompt("Code: "));
    if (!code) {
      if (left > 0) log(`No code entered. Type the code shown in your browser ${retryHint}.`);
      continue;
    }
    let result: unknown;
    try {
      result = await redeem({ code, verifier });
    } catch (error) {
      if (!isInvalidOrExpired(error)) throw error;
      if (left > 0) log(`That code is invalid or expired. Check it and type it again ${retryHint}.`);
      continue;
    }
    await saveToken(tokenFrom(result), siteUrl.origin, options.file);
    log(SIGNED_IN_MESSAGE);
    return;
  }
  throw new Error(`Sign-in failed: no valid code after ${maxAttempts} attempts (invalid or expired). Run \`kanban login --code\` to start again.`);
}

type PendingLogin = { site: string; verifier: string; expiresAt: number };

async function readPendingLogin(file: string): Promise<PendingLogin | null> {
  let data: unknown;
  try { data = JSON.parse(await readFile(file, "utf8")); }
  catch { return null; }
  if (typeof data !== "object" || data === null) return null;
  const { site, verifier, expiresAt } = data as Record<string, unknown>;
  if (typeof site !== "string" || typeof verifier !== "string" || typeof expiresAt !== "number") return null;
  return { site, verifier, expiresAt };
}

/**
 * Second step of a code sign-in started without a terminal: `kanban login --code <CODE>`.
 * An invalid code keeps the pending sign-in so the user can retry until it expires.
 */
export async function finishCodeLogin(site: string, code: string, options: CodeLoginOptions = {}): Promise<void> {
  const siteUrl = loginSite(site);
  const pendingFile = options.pendingFile ?? pendingLoginFile;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const normalized = normalizeCode(code);
  if (!normalized) throw new UsageError("Pass the code the sign-in page shows: kanban login --code <CODE>.");
  const pending = await readPendingLogin(pendingFile);
  if (!pending) throw new Error("No pending sign-in on this machine. Run `kanban login --code` first, then `kanban login --code <CODE>`.");
  if (pending.site !== siteUrl.origin) {
    throw new Error(`The pending sign-in was started for ${pending.site}, not ${siteUrl.origin}. Run \`kanban login --code\` again.`);
  }
  if (pending.expiresAt <= now()) {
    await rm(pendingFile, { force: true });
    throw new Error("The pending sign-in has expired. Run `kanban login --code` to start again.");
  }
  const redeem = options.redeem ?? convexRedeemer(siteUrl.origin);
  let result: unknown;
  try {
    result = await redeem({ code: normalized, verifier: pending.verifier });
  } catch (error) {
    if (isInvalidOrExpired(error)) {
      throw new Error("That code is invalid or expired. Check it and run `kanban login --code <CODE>` again, or start over with `kanban login --code`.");
    }
    throw error;
  }
  await saveToken(tokenFrom(result), siteUrl.origin, options.file);
  await rm(pendingFile, { force: true });
  log(SIGNED_IN_MESSAGE);
}
