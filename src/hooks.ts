import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const MARKER = "# managed by kanban hooks";
const KEY = /\b[A-Z][A-Z0-9]{1,4}-\d+\b/g;

export type PushRef = { localRef: string; localSha: string; remoteRef: string; remoteSha: string };

export function parsePushRefs(input: string): PushRef[] {
  return input.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error(`Invalid pre-push ref line: ${line}`);
    return { localRef: fields[0], localSha: fields[1], remoteRef: fields[2], remoteSha: fields[3] };
  });
}

export function extractItemKeys(messages: readonly string[]): string[] {
  return [...new Set(messages.flatMap((message) => [...message.matchAll(KEY)].map((match) => match[0])))];
}

export function hookScript(stage: "pre-commit" | "pre-push"): string {
  return `#!/bin/sh\n${MARKER}\nexec kanban hooks check --stage ${stage}\n`;
}

function gitPath(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["rev-parse", ...args], { cwd, encoding: "utf8" }).trim();
}

export function activeItemFile(cwd = process.cwd()): string {
  return resolve(cwd, gitPath(cwd, "--git-path", "kanban-item"));
}

export async function setActiveItem(key: string, cwd = process.cwd()): Promise<void> {
  if (!/^[A-Z][A-Z0-9]{1,4}-\d+$/.test(key)) throw new Error("Use a work item key such as WEB-12");
  const file = activeItemFile(cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readActiveItem(cwd = process.cwd()): Promise<string> {
  try {
    const key = (await readFile(activeItemFile(cwd), "utf8")).trim();
    if (!/^[A-Z][A-Z0-9]{1,4}-\d+$/.test(key)) throw new Error("Active item file is invalid. Run `kanban hooks set-item KEY`.");
    return key;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("No active Kanban item. Run `kanban hooks set-item KEY` before committing.");
    }
    throw error;
  }
}

export async function installHooks(cwd = process.cwd()): Promise<{ installed: string[] }> {
  const hooksDir = resolve(cwd, gitPath(cwd, "--git-path", "hooks"));
  await mkdir(hooksDir, { recursive: true });
  const existingHooks = await Promise.all((["pre-commit", "pre-push"] as const).map(async (stage) => {
    try { return [stage, await readFile(join(hooksDir, stage), "utf8")] as const; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [stage, undefined] as const;
      throw error;
    }
  }));
  const collision = existingHooks.find(([stage, content]) => content !== undefined && content !== hookScript(stage));
  if (collision) throw new Error(`Existing ${collision[0]} hook left untouched at ${join(hooksDir, collision[0])}. Add 'kanban hooks check --stage ${collision[0]}' to it manually.`);
  const installed: string[] = [];
  for (const stage of ["pre-commit", "pre-push"] as const) {
    const file = join(hooksDir, stage);
    const existing = existingHooks.find(([candidate]) => candidate === stage)?.[1];
    const script = hookScript(stage);
    if (existing === script) continue;
    await writeFile(file, script, { mode: 0o755, flag: "wx" });
    await chmod(file, 0o755);
    installed.push(stage);
  }
  return { installed };
}

export async function hooksStatus(cwd = process.cwd()): Promise<Array<{ stage: string; installed: boolean }>> {
  const hooksDir = resolve(cwd, gitPath(cwd, "--git-path", "hooks"));
  return Promise.all((["pre-commit", "pre-push"] as const).map(async (stage) => {
    try { return { stage, installed: (await readFile(join(hooksDir, stage), "utf8")) === hookScript(stage) }; }
    catch { return { stage, installed: false }; }
  }));
}

export function outgoingCommitMessages(refs: readonly PushRef[], cwd = process.cwd()): string[][] {
  const messages: string[][] = [];
  for (const ref of refs) {
    if (/^0+$/.test(ref.localSha)) continue;
    const args = ["rev-list", ref.localSha];
    if (!/^0+$/.test(ref.remoteSha)) args.push(`^${ref.remoteSha}`);
    const commits = execFileSync("git", args, { cwd, encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    for (const commit of commits) messages.push([execFileSync("git", ["show", "-s", "--format=%B", commit], { cwd, encoding: "utf8" }).trim()]);
  }
  return messages;
}
