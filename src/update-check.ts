import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configFile } from "./config.js";

export type UpdateCache = { checkedAt: number; latest: string | null };
export type UpdateResult = { current: string; latest: string | null; updateAvailable: boolean };

const REGISTRY_URL = "https://registry.npmjs.org/@seridian/kanban-cli/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
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
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await (options.fetcher ?? fetch)(REGISTRY_URL, { signal: controller.signal });
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
  return options.stdoutIsTTY === true && options.json !== true && !command.includes("--json") && env.KANBAN_NO_UPDATE_CHECK !== "1" && !env.CI && command[0] !== "agent-help" && !(command[0] === "update" && command[1] === "check");
}
