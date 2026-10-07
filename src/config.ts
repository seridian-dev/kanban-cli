import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type LocalConfig = {
  site?: string;
  user?: string;
  project?: string;
  workspace?: string;
  links?: Array<{ path: string; project: string; workspace?: string; github?: string; boardUrl?: string }>;
};

export const configFile = () => process.env.KANBAN_CONFIG_FILE ?? join(homedir(), ".config", "kanban", "config.json");

export async function readConfig(): Promise<LocalConfig> {
  try {
    const parsed = JSON.parse(await readFile(configFile(), "utf8")) as LocalConfig;
    return {
      site: typeof parsed.site === "string" ? parsed.site : undefined,
      user: typeof parsed.user === "string" ? parsed.user : undefined,
      project: typeof parsed.project === "string" ? parsed.project.toUpperCase() : undefined,
      workspace: typeof parsed.workspace === "string" ? parsed.workspace.toLowerCase() : undefined,
      links: Array.isArray(parsed.links) ? parsed.links.filter((x) => x && typeof x.path === "string" && typeof x.project === "string").map((x) => ({ path: resolve(x.path), project: x.project.toUpperCase(), workspace: typeof x.workspace === "string" ? x.workspace.toLowerCase() : undefined, ...(typeof x.github === "string" ? { github: x.github } : {}), ...(typeof x.boardUrl === "string" ? { boardUrl: x.boardUrl } : {}) })) : [],
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { links: [] };
    throw new Error(`Could not read ${configFile()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeConfig(config: LocalConfig): Promise<void> {
  const file = configFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export function gitRoot(cwd = process.cwd()): string {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error("This folder is not inside a Git repository. Run `kanban link --project KEY --path .` from a folder to link it directly."); }
}

export function linkedProject(config: LocalConfig, cwd = process.cwd()): string | undefined {
  return linkedContext(config, cwd)?.project;
}

export function linkedContext(config: LocalConfig, cwd = process.cwd()): { project: string; workspace?: string; github?: string; boardUrl?: string } | undefined {
  const current = resolve(cwd);
  return [...(config.links ?? [])]
    .filter((link) => current === link.path || current.startsWith(link.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** owner/name from a GitHub remote URL (https or ssh), else undefined. */
export function parseGithubRemote(url: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** The GitHub repo this checkout pushes to: origin (your fork), never an upstream remote. */
export function detectGithubRepo(cwd = process.cwd()): string | undefined {
  try { return parseGithubRemote(execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return undefined; }
}
