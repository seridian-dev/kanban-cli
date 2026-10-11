import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { hostname } from "node:os";

const authFile = join(homedir(), ".config", "kanban", "auth.json");
const MAX_CALLBACK_BYTES = 8 * 1024;
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function readAuth(file = authFile): Promise<{ token: string; site?: string } | null> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { token?: unknown; site?: unknown };
    return typeof data.token === "string" ? { token: data.token, site: typeof data.site === "string" ? data.site : undefined } : null;
  } catch { return null; }
}

export async function clearToken(file = authFile): Promise<void> { await rm(file, { force: true }); }

async function saveToken(token: string, site: string, file = authFile): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(file, JSON.stringify({ token, site: new URL(site).origin, savedAt: new Date().toISOString() }), { mode: 0o600 });
  await chmod(file, 0o600);
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

export async function browserLogin(site: string, options: LoginOptions = {}): Promise<void> {
  let siteUrl: URL;
  try { siteUrl = new URL(site); }
  catch { throw new Error("Set the Kanban website URL, such as https://kanban.seridian.dev."); }
  if (siteUrl.protocol !== "https:" && !(siteUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(siteUrl.hostname))) {
    throw new Error("Kanban sign-in requires HTTPS for remote sites.");
  }

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
    if (a.length !== b.length || !timingSafeEqual(a, b) || token.length < 20 || token.length > 4096) {
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
    (options.open ?? openBrowser)(login.href);
    await completed;
    console.log("Signed in. Your Kanban access token is stored in ~/.config/kanban/auth.json with owner-only permissions. It expires after three days; run `kanban login` again to reconnect.");
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
