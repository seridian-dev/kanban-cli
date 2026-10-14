import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configFile } from "./config.js";
import { createHttpFetch } from "./http.js";

export type UpdateCache = { checkedAt: number; latest: string | null };
export type UpdateResult = { current: string; latest: string | null; updateAvailable: boolean };

const REGISTRY_URL = "https://registry.npmjs.org/@seridian/kanban-cli/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The registry check must never delay a command for long: it aborts after 2 seconds (KAN-260). */
export const CHECK_TIMEOUT_MS = 2_000;
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const cacheFile = () => join(dirname(configFile()), "update-check.json");

export async function currentVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
  return pkg.version;
}

export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`Invalid semver: ${value}`);
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function readCache(): Promise<UpdateCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf8")) as UpdateCache;
    return typeof parsed.checkedAt === "number" && (typeof parsed.latest === "string" || parsed.latest === null) ? parsed : undefined;
  } catch { return undefined; }
}

export async function checkForUpdate(options: { force?: boolean; fetcher?: typeof fetch; now?: number } = {}): Promise<UpdateResult> {
  const current = await currentVersion();
  const now = options.now ?? Date.now();
  const cached = await readCache();
  let latest: string | null;
  if (!options.force && cached && now - cached.checkedAt < DAY_MS && now >= cached.checkedAt) latest = cached.latest;
  else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      // One attempt only: this runs after a command and must never delay it.
      const response = await (options.fetcher ?? createHttpFetch({ retries: 0 }))(REGISTRY_URL, { signal: controller.signal });
      if (!response.ok) throw new Error("Registry request failed");
      const body = await response.json() as { version?: unknown };
      if (typeof body.version !== "string") throw new Error("Invalid registry response");
      latest = body.version;
      const file = cacheFile();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify({ checkedAt: now, latest })}\n`, { mode: 0o600 });
    } finally { clearTimeout(timer); }
  }
  return { current, latest, updateAvailable: latest !== null && compareSemver(current, latest) < 0 };
}

export function updateInstallCommand(): string {
  return typeof process.versions.bun === "string" ? "bun add -g @seridian/kanban-cli" : "npm i -g @seridian/kanban-cli";
}

export function shouldShowUpdateNotice(options: { stdoutIsTTY?: boolean; json?: boolean; command?: string[]; env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = options.env ?? process.env;
  const command = options.command ?? process.argv.slice(2);
  return options.stdoutIsTTY === true && options.json !== true && !command.includes("--json") && env.KANBAN_NO_UPDATE !== "1" && env.KANBAN_NO_UPDATE_CHECK !== "1" && !env.CI && command[0] !== "agent-help" && command[0] !== "schema" && !(command[0] === "update" && command[1] === "check");
}

// KAN-260: pre-run auto-update. When a newer npm release exists and the CLI is installed
// globally, it is installed and the original command re-runs with the new version. Every
// failure is soft: one hint on stderr, then the command proceeds as usual.

export type AutoUpdateOutcome = { action: "rerun"; status: number } | { action: "continue" };

export type AutoUpdateDeps = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  now?: number;
  fetcher?: typeof fetch;
  globalInstall?: boolean;
  installer?: (latest: string) => { status: number | null };
  reexec?: () => { status: number | null };
  warn?: (line: string) => void;
};

/** True when this invocation came from npx: its cache path, or npm's exec lifecycle. */
export function isUnderNpx(options: { script?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = options.env ?? process.env;
  if (env.npm_command === "exec" || env.npm_command === "npx") return true;
  if (typeof env.npm_execpath === "string" && /[\\/]npx-cli\.js$/.test(env.npm_execpath)) return true;
  try {
    return realpathSync(options.script ?? process.argv[1] ?? "").split(sep).includes("_npx");
  } catch { return false; }
}

/** `npm prefix -g`, where npm installs and updates global packages. */
export function npmGlobalPrefix(): string | undefined {
  if (process.versions.bun) return undefined;
  try {
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["prefix", "-g"], { encoding: "utf8", timeout: 5_000 });
    const value = result.stdout?.trim();
    return value ? value : undefined;
  } catch { return undefined; }
}

function globalModuleRoots(prefix: string): string[] {
  const roots = [join(prefix, "lib", "node_modules"), join(prefix, "node_modules")];
  if (process.versions.bun) roots.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return roots;
}

/** True when the running kanban.js lives in npm's (or Bun's) global node_modules, not npx's cache or a project. */
export function isGlobalInstall(options: { script?: string; prefix?: string } = {}): boolean {
  try {
    const script = realpathSync(options.script ?? process.argv[1] ?? "");
    if (script.split(sep).includes("_npx")) return false;
    const prefix = realpathSync(options.prefix ?? npmGlobalPrefix() ?? "");
    return globalModuleRoots(prefix).some((root) => {
      try { return script.startsWith(realpathSync(root) + sep); } catch { return false; }
    });
  } catch { return false; }
}

/** The one hint a failed auto-update is allowed to print. */
export function autoUpdateHint(latest?: string): string {
  const to = latest ? ` to ${latest}` : "";
  return `Could not auto-update @seridian/kanban-cli${to}; run \`${updateInstallCommand()}\` to update manually.`;
}

/** Skip rules for the pre-run auto-update: opt-out, CI, --json off-TTY, npx, and offline-first commands. */
export function shouldAutoUpdate(options: { argv?: string[]; env?: NodeJS.ProcessEnv; stdoutIsTTY?: boolean } = {}): boolean {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  if (env.KANBAN_NO_UPDATE === "1") return false;
  if (/^(1|true)$/i.test(env.CI ?? "")) return false;
  if (argv.includes("--json") && options.stdoutIsTTY !== true) return false;
  if (isUnderNpx({ env })) return false;
  if (["help", "agent-help", "schema"].includes(argv[0] ?? "")) return false;
  if (argv[0] === "update" && argv[1] === "check") return false;
  return true;
}

function defaultInstaller(latest: string): { status: number | null } {
  const pkg = `@seridian/kanban-cli@${latest}`;
  const bun = typeof process.versions.bun === "string";
  const command = bun ? "bun" : process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, bun ? ["add", "-g", pkg] : ["install", "-g", pkg], { stdio: "ignore", timeout: 120_000 });
  return { status: result.status };
}

function defaultReexec(): { status: number | null } {
  const result = spawnSync(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, KANBAN_NO_UPDATE: "1" },
  });
  return { status: result.status };
}

/**
 * Pre-run auto-update (KAN-260). Checks npm at most once per 24 h (cached in
 * ~/.config/kanban, 2 s timeout). When a newer version is published and this is a global
 * install, installs it and re-runs the original command with the new version. Any failure
 * prints one hint and the command continues as usual.
 */
export async function autoUpdate(deps: AutoUpdateDeps = {}): Promise<AutoUpdateOutcome> {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!shouldAutoUpdate({ argv: deps.argv, env: deps.env, stdoutIsTTY: deps.stdoutIsTTY ?? process.stdout.isTTY })) return { action: "continue" };
  let result: UpdateResult;
  try {
    result = await checkForUpdate({ fetcher: deps.fetcher, now: deps.now });
  } catch {
    warn(autoUpdateHint());
    return { action: "continue" };
  }
  if (!result.updateAvailable) return { action: "continue" };
  // Not global (project dep, dev checkout): the quiet post-run notice stays in charge.
  if (!(deps.globalInstall ?? isGlobalInstall())) return { action: "continue" };
  try {
    const install = (deps.installer ?? defaultInstaller)(result.latest!);
    if (install.status !== 0) throw new Error(`installer exited with status ${install.status}`);
    warn(`Updated @seridian/kanban-cli to ${result.latest}; re-running with the new version.`);
    const child = (deps.reexec ?? defaultReexec)();
    return { action: "rerun", status: child.status ?? 1 };
  } catch {
    warn(autoUpdateHint(result.latest!));
    return { action: "continue" };
  }
}
