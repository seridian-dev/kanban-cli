import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const authFile = join(homedir(), ".config", "kanban", "auth.json");
export async function readAuth(): Promise<{ token: string; site?: string } | null> {
  try {
    const data = JSON.parse(await readFile(authFile, "utf8")) as { token?: unknown; site?: unknown };
    return typeof data.token === "string" ? { token: data.token, site: typeof data.site === "string" ? data.site : undefined } : null;
  } catch { return null; }
}
export async function clearToken(): Promise<void> { await rm(authFile, { force: true }); }

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function browserLogin(site: string): Promise<void> {
  const state = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/callback" || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
      response.writeHead(404).end("Not found"); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const receivedState = form.get("state") ?? "";
    const token = form.get("token") ?? "";
    const a = Buffer.from(state), b = Buffer.from(receivedState);
    if (a.length !== b.length || !timingSafeEqual(a, b) || token.length < 20) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in check failed. Close this tab and run kanban login again.");
      return;
    }
    await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
    await writeFile(authFile, JSON.stringify({ token, site, savedAt: new Date().toISOString() }), { mode: 0o600 });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Kanban CLI connected</title><main style='font:16px system-ui;max-width:36rem;margin:12vh auto;padding:1rem'><h1>You're signed in to Kanban CLI</h1><p>You can close this tab and return to your terminal.</p></main>");
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the local sign-in callback");
  const callback = `http://127.0.0.1:${address.port}/callback`;
  const login = new URL("/cli/login", site);
  login.searchParams.set("callback", callback);
  login.searchParams.set("state", state);
  console.log("Opening Kanban in your browser. Sign in, then choose ‘Authorize CLI’.\nIf it does not open, visit:\n" + login.href);
  openBrowser(login.href);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error("Sign-in timed out. Run kanban login to try again.")); }, 5 * 60_000);
    server.once("close", () => { clearTimeout(timer); resolve(); });
  });
  console.log("Signed in. Your Kanban session token is stored in ~/.config/kanban/auth.json with owner-only permissions.");
}
