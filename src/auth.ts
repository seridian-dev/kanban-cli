import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

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
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end("<!doctype html><title>Kanban CLI connected</title><main style='font:16px system-ui;max-width:36rem;margin:12vh auto;padding:1rem'><h1>You're signed in to Kanban CLI</h1><p>You can close this tab and return to your terminal.</p></main>");
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
