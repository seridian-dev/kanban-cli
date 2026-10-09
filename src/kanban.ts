#!/usr/bin/env node
/**
 * kanban — terminal interface for coding agents. Every command supports --json.
 * Exit codes: 0 ok · 1 server/runtime error · 2 usage error · 3 not found.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "./api.js";
import type { Id } from "./dataModel.js";
import type { CliConvexClient } from "./client.js";
import { AGENT_HELP, FULL_HELP } from "./help.js";
import { DEFAULT_KANBAN_URL, resolveBackendUrl } from "./backend.js";
import { browserLogin, clearToken, openBrowser, readAuth } from "./auth.js";
import { detectGithubRepo, gitRoot, linkedContext, readConfig, writeConfig } from "./config.js";
import { formatChangelog, withGeneratedChangelog } from "./changelog.js";
import { runGit } from "./git.js";
import { findIssue, formatReport, prDraft, syncGithub } from "./gh-sync.js";
import { formatNext, formatPlan, pickNext, planSprint } from "./planning.js";
import { execFileSync } from "node:child_process";
import { extractItemKeys, hooksStatus, installHooks, outgoingCommitMessages, parsePushRefs, readActiveItem, setActiveItem, validateHookItems } from "./hooks.js";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkForUpdate, shouldShowUpdateNotice, updateInstallCommand } from "./update-check.js";
import { resolve } from "node:path";
import { classifyError, compactItems, describeDryRun, dryRunPayload, flagFields, formatTable, formatTree, parseArgs, parseKey, pickSprint, readAll, splitList, UsageError, type Parsed, type WouldChange } from "./lib.js";
import { findCommand, schemaDocument } from "./schema.js";
import { readRetriesFromEnv, wrapClient } from "./retry.js";

class CliError extends Error {
  constructor(message: string, readonly code: 1 | 2 | 3 = 1) {
    super(message);
  }
}

const usage = (m: string) => new CliError(m, 2);

function cleanServerError(e: unknown): string {
  // Server rules throw ConvexError; its data is the exact message (production redacts plain Errors).
  if (e && typeof e === "object" && "data" in e && typeof (e as { data: unknown }).data === "string") return (e as { data: string }).data;
  const raw = e instanceof Error ? e.message : String(e);
  const m = /Uncaught (?:Convex)?Error: ([^\n]+?)(?: at | Called by|$|\n)/.exec(raw);
  return (m?.[1] ?? raw.split("\n")[0]).trim();
}

/** Flags that `items update` turns into a patch; --dry-run echoes the ones passed. */
const UPDATE_FLAGS = ["title", "description", "type", "status", "priority", "assignee", "start", "due", "labels", "points", "parent", "depends-on", "sprint"];
const CREATE_FLAGS = ["type", "title", "description", "parent", "status", "priority", "assignee", "labels", "points", "start", "due", "sprint"];

/** Test seam: `deps.client` replaces the Convex client, so no server is contacted. */
export interface CliDeps {
  client?: CliConvexClient;
  /** Test seam: replaces the retry backoff wait so tests run without delays. */
  sleep?: (ms: number) => Promise<void>;
}

export async function main(argv: string[], deps: CliDeps = {}) {
  await runMain(argv, deps);
}

async function createClient(endpoint: string, token: string | undefined): Promise<CliConvexClient> {
  let url: string;
  try { url = await resolveBackendUrl(endpoint); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error)); }
  const client = new ConvexHttpClient(url);
  if (token) client.setAuth(token);
  return client as unknown as CliConvexClient;
}

async function runMain(argv: string[], deps: CliDeps) {
  const { positionals: pos, flags } = parseArgs(argv);
  const json = flags.json === true;
  const out = (data: unknown, human: string) => console.log(json ? JSON.stringify(data, null, flags.compact === true ? undefined : 2) : human);
  if (pos.length === 0 || pos[0] === "help" || flags.help) {
    console.log(FULL_HELP);
    return;
  }
  if (pos[0] === "agent-help") {
    console.log(AGENT_HELP);
    return;
  }
  if (pos[0] === "schema") {
    // Always JSON, and no config, auth, or network access, so it works offline and in CI.
    const words = pos.slice(1);
    if (words.length === 0) {
      console.log(JSON.stringify(schemaDocument(), null, 2));
      return;
    }
    const spec = findCommand(words);
    if (!spec) {
      console.error(JSON.stringify({ error: `Unknown command: ${words.join(" ")}. Run 'kanban schema' for every command.`, code: 3 }));
      process.exitCode = 3;
      return;
    }
    console.log(JSON.stringify(spec, null, 2));
    return;
  }

  if (pos[0] === "update" && pos[1] === "check") {
    try {
      const result = await checkForUpdate({ force: true });
      out(result, result.updateAvailable ? `Update available: ${result.current} → ${result.latest}` : result.latest ? `Up to date (${result.current})` : "Could not check for updates.");
    } catch { out({ checked: false }, "Could not check for updates."); }
    return;
  }

  const [group, sub, arg] = pos;
  const config = await readConfig();
  const auth = await readAuth();
  const localSite = str(flags.url) ?? process.env.KANBAN_URL ?? config.site ?? auth?.site ?? DEFAULT_KANBAN_URL;
  if (pos[0] === "config") {
    if (!sub || sub === "show") return out(config, `Site: ${config.site ?? DEFAULT_KANBAN_URL}\nUser: ${config.user ?? "not set"}\nDefault workspace: ${config.workspace ?? "not set"}\nDefault project: ${config.project ?? "not set"}\nProject links: ${config.links?.length ?? 0}\nConfig: ~/.config/kanban/config.json (no credentials stored here)`);
    if (sub === "set") {
      const name = arg;
      const value = pos[3] ?? str(flags.value);
      if (!name || !value) throw usage("Use `kanban config set site|user|project VALUE`");
      if (name === "site") {
        if (/\.convex\.(cloud|site)(\/|$)/.test(value)) throw usage("Set the Kanban website URL, such as https://kanban.seridian.dev.");
        config.site = new URL(value).origin;
      } else if (name === "user") config.user = value;
      else if (name === "project") config.project = value.toUpperCase();
      else if (name === "workspace") config.workspace = value.toLowerCase();
      else throw usage("Config keys are site, user, workspace, or project.");
      await writeConfig(config);
      return out(config, `Saved ${name} in ~/.config/kanban/config.json`);
    }
    throw usage("Use `kanban config [show]` or `kanban config set site|user|project VALUE`");
  }
  if (pos[0] === "link") {
    const projectKey = str(flags.project)?.toUpperCase();
    if (!projectKey || !/^[A-Z][A-Z0-9]{1,4}$/.test(projectKey)) throw usage("Use `kanban link --project KEY [--path .]`; KEY is a project key like WEB.");
    const path = resolve(str(flags.path) ?? gitRoot());
    const workspace = (str(flags.workspace) ?? process.env.KANBAN_WORKSPACE ?? config.workspace)?.toLowerCase();
    const github = str(flags.github) ?? detectGithubRepo(path);
    const previous = (config.links ?? []).find((link) => resolve(link.path) === path);
    const boardUrl = str(flags["board-url"]) ?? previous?.boardUrl;
    config.links = [...(config.links ?? []).filter((link) => resolve(link.path) !== path), { path, project: projectKey, workspace, github, ...(boardUrl ? { boardUrl } : {}) }];
    await writeConfig(config);
    return out({ path, project: projectKey, workspace, github }, `Linked ${path} to ${workspace ? `${workspace}/` : ""}${projectKey}.${github ? ` GitHub: ${github} (used by \`kanban gh sync\`).` : ""} Nested folders use this project unless they have a more specific link.`);
  }
  if (pos[0] === "links") {
    if (sub === "list" || !sub) return out(config.links ?? [], (config.links?.length ? config.links.map((link) => `${link.workspace ? `${link.workspace}/` : ""}${link.project}  ${link.path}`).join("\n") : "No local project links yet. Run `kanban link --project KEY` inside a repo."));
    if (sub === "remove" || sub === "unlink") {
      const path = resolve(str(flags.path) ?? gitRoot());
      const before = config.links?.length ?? 0;
      config.links = (config.links ?? []).filter((link) => resolve(link.path) !== path);
      await writeConfig(config);
      return out({ removed: before - (config.links?.length ?? 0), path }, `Removed local project link for ${path}`);
    }
    throw usage("Use `kanban links list` or `kanban links remove [--path .]`");
  }
  if (group === "hooks" && sub !== "check") {
    if (sub === "install") {
      const result = await installHooks();
      return out(result, result.installed.length ? `Installed ${result.installed.join(" and ")} Kanban hooks.` : "Kanban hooks are already installed.");
    }
    if (sub === "set-item") {
      const key = need(arg, "item key").toUpperCase();
      await setActiveItem(key);
      return out({ activeItem: key }, `Active item set to ${key} for this Git repository.`);
    }
    if (sub === "doctor") {
      const statuses = await hooksStatus();
      const activeItem = await readActiveItem().catch(() => undefined);
      const result = { activeItem, hooks: statuses };
      return out(result, `Active item: ${activeItem ?? "not set"}\nHooks: ${statuses.map((s) => `${s.stage} ${s.installed ? "installed" : "not installed"}`).join(", ")}`);
    }
    throw usage("Use `kanban hooks install`, `kanban hooks set-item KEY`, `kanban hooks doctor`, or `kanban hooks check --stage STAGE`.");
  }
  if (pos[0] === "context") {
    let root: string | undefined;
    try { root = gitRoot(); } catch { /* Linking a plain folder is supported. */ }
    const mapping = linkedContext(config);
    const workspace = str(flags.workspace)?.toLowerCase() ?? process.env.KANBAN_WORKSPACE?.toLowerCase() ?? mapping?.workspace ?? config.workspace;
    const effectiveProject = str(flags.project)?.toUpperCase() ?? process.env.KANBAN_PROJECT?.toUpperCase() ?? mapping?.project ?? config.project;
    const github = mapping?.github ?? (root ? detectGithubRepo(root) : undefined);
    const context = { folder: process.cwd(), gitRoot: root, github, linkedProject: mapping?.project, workspace, project: effectiveProject };
    return out(context, `Folder: ${context.folder}\nGit repo: ${root ?? "none"}\nGitHub: ${github ?? "none"}\nWorkspace: ${workspace ?? "not set"}\nLinked project: ${mapping ? `${mapping.workspace ? `${mapping.workspace}/` : ""}${mapping.project}` : "none"}\nActive project: ${effectiveProject ?? "not set"}`);
  }

  if (group === "login" || (group === "auth" && sub === "login")) {
    const site = localSite;
    if (/\.convex\.(cloud|site)(\/|$)/.test(site)) throw usage("Sign-in needs the Kanban website URL, for example https://kanban.seridian.dev");
    await browserLogin(site);
    return;
  }
  if (group === "logout" || (group === "auth" && sub === "logout")) {
    await clearToken();
    console.log("Signed out of Kanban CLI on this device.");
    return;
  }

  // Reads retry on transient failures (KANBAN_RETRIES, default 2); writes are attempted once.
  const retries = readRetriesFromEnv(process.env);
  const client = wrapClient(deps.client ?? await createClient(localSite, auth?.token), { retries, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), random: Math.random });
  const actor = str(flags.as) ?? process.env.KANBAN_USER ?? config.user ?? "cli";
  // --dry-run: validation and key resolution run as usual; the write is reported instead of sent.
  const dryRun = flags["dry-run"] === true;
  const dryRunOut = (wouldChange: WouldChange[]) => out(dryRunPayload(wouldChange), describeDryRun(wouldChange));
  let accountDefaults: Promise<{ workspaceSlug: string | null; projectKey: string | null } | null> | undefined;
  const getAccountDefaults = () => accountDefaults ??= client.query(api.preferences.getCliDefaults, {}).then((value: any) => ({ workspaceSlug: value?.workspaceSlug ?? null, projectKey: value?.projectKey ?? null })).catch((error: unknown) => {
    if (/Could not find public function/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  });
  const workspaceLocal = () => str(flags.workspace)?.toLowerCase() ?? process.env.KANBAN_WORKSPACE?.toLowerCase() ?? linkedContext(config)?.workspace ?? config.workspace;
  const workspaceSlug = async () => workspaceLocal() ?? (await getAccountDefaults())?.workspaceSlug?.toLowerCase();
  const workspaceFor = async (slug?: string) => {
    slug ??= await workspaceSlug();
    if (!slug) return undefined;
    const workspace = await client.query(api.organizations.getBySlug, { slug });
    if (!workspace) throw new CliError(`Workspace ${slug} not found or unavailable`, 3);
    return workspace;
  };
  const inferredWorkspaceSlugs = new Map<string, Promise<string | undefined>>();
  const workspaceForProject = async (key: string): Promise<string | undefined> => {
    const projectKey = key.toUpperCase();
    const selected = await workspaceSlug();
    if (selected) return selected;
    const cached = inferredWorkspaceSlugs.get(projectKey);
    if (cached) return cached;
    const result = (async () => {
      const projects = await client.query(api.projects.list, {});
      const matches = projects.filter((candidate) => candidate.key === projectKey);
      if (matches.length > 1) {
        const workspaces = await client.query(api.organizations.listMine, {});
        const locations = matches.map((candidate) => {
          const workspace = workspaces.find((row) => row._id === candidate.organizationId);
          return workspace?.slug ?? "personal";
        });
        throw usage(`Project ${projectKey} exists in multiple workspaces (${locations.join(", ")}). Pass --workspace SLUG or link this folder to one.`);
      }
      if (!matches[0]?.organizationId) return undefined;
      const workspaces = await client.query(api.organizations.listMine, {});
      return workspaces.find((row) => row._id === matches[0].organizationId)?.slug;
    })();
    inferredWorkspaceSlugs.set(projectKey, result);
    return result;
  };
  const projectLocal = () => str(flags.project)?.toUpperCase() ?? process.env.KANBAN_PROJECT?.toUpperCase() ?? linkedContext(config)?.project ?? config.project;
  const project = async () => {
    const p = projectLocal() ?? (await getAccountDefaults())?.projectKey ?? undefined;
    if (!p) throw usage("--project KEY is required. Or link this folder with `kanban link --project KEY`, or set a default project in Kanban → Settings → CLI defaults.");
    return p.toUpperCase();
  };

  if (group === "defaults") {
    const mapping = linkedContext(config);
    const workspaceValue = workspaceLocal();
    const projectValue = projectLocal();
    const defaults = workspaceValue && projectValue ? null : await getAccountDefaults();
    const workspace = workspaceValue ?? defaults?.workspaceSlug?.toLowerCase();
    const selectedProject = projectValue ?? defaults?.projectKey?.toUpperCase();
    const source = (local: string | undefined, name: "workspace" | "project") => {
      if (str(flags[name])) return "flag";
      if (process.env[name === "workspace" ? "KANBAN_WORKSPACE" : "KANBAN_PROJECT"]) return "env";
      if (name === "workspace" ? mapping?.workspace : mapping?.project) return "folder link";
      if (config[name]) return "config";
      return defaults && (name === "workspace" ? defaults.workspaceSlug : defaults.projectKey) ? "account" : "not set";
    };
    const result = { workspace: { value: workspace ?? null, source: source(workspaceValue, "workspace") }, project: { value: selectedProject ?? null, source: source(projectValue, "project") } };
    return out(result, `Workspace: ${workspace ?? "not set"} (${result.workspace.source})\nProject: ${selectedProject ?? "not set"} (${result.project.source})`);
  }

  const idOf = async (key: string): Promise<Id<"workItems">> => {
    if (!parseKey(key)) throw usage(`"${key}" is not an item key like WEB-12`);
    const item = await client.query(api.agentApi.getByKey, { key, workspaceSlug: await workspaceForProject(parseKey(key)!.project) });
    if (!item) throw new CliError(`Item ${key.toUpperCase()} not found`, 3);
    return item._id;
  };
  const idsOf = async (keys: string[]) => Promise.all(keys.map(idOf));

  const sprintOf = async (ref: string, projectKey: string): Promise<Id<"sprints">> => {
    const p = await client.query(api.projects.getByKey, { key: projectKey, workspaceSlug: await workspaceForProject(projectKey) });
    if (!p) throw new CliError(`Project ${projectKey} not found`, 3);
    const sprints = await client.query(api.sprints.listByProject, { projectId: p._id });
    const hit = pickSprint(sprints, ref);
    if (!hit) throw new CliError(`Sprint "${ref}" not found in ${projectKey}`, 3);
    return hit._id as Id<"sprints">;
  };
  const projectOfKey = (key: string) => parseKey(key)!.project;

  if (pos[0] === "next" || pos[0] === "plan") {
    const pk = await project();
    const workspaceSlug = await workspaceForProject(pk);
    const p = await client.query(api.projects.getByKey, { key: pk, workspaceSlug });
    if (!p) throw new CliError(`Project ${pk} not found`, 3);
    const items = await client.query(api.workItems.listByProject, { projectId: p._id });
    const sprints = await client.query(api.sprints.listByProject, { projectId: p._id });
    if (pos[0] === "next") {
      const pick = pickNext(items, sprints, str(flags.assignee) ?? actor);
      const item = pick.item;
      const data = item
        ? { key: item.key, title: item.title, type: item.type, status: item.status, priority: item.priority ?? "none", assignee: item.assignee ?? null, points: item.points ?? null, reason: pick.reason, command: `kanban items move ${item.key} --status in_progress` }
        : { key: null, reason: pick.reason };
      return out(data, item ? formatNext(pick) : `Nothing to pick up in ${pk}. ${pick.reason}`);
    }
    const report = planSprint(items, sprints);
    return out({ project: pk, ...report }, formatPlan(report, pk));
  }

  switch (group) {
    case "hooks": {
      const stage = str(flags.stage);
      if (stage === "pre-commit") {
        const key = await readActiveItem();
        const selectedProject = await project();
        const items = await validateHookItems([key], selectedProject, ["in_progress", "in_review"], async (itemKey) => {
          const detail = await client.query(api.agentApi.detail, { key: itemKey, workspaceSlug: await workspaceForProject(selectedProject) });
          return detail ? { key: itemKey, status: detail.item.status } : null;
        });
        return out({ stage, key, status: items[0].status }, `Kanban check passed: ${key} (${items[0].status}).`);
      }
      if (stage === "pre-push") {
        const refs = parsePushRefs(await readStdin());
        const messages = outgoingCommitMessages(refs);
        if (!messages.length) return out({ stage, keys: [] }, "Kanban check passed: no outgoing commits.");
        const keysByCommit = messages.map(extractItemKeys);
        if (keysByCommit.some((commitKeys) => commitKeys.length === 0)) throw new CliError("Every outgoing commit must reference a Kanban item key (for example KAN-185).", 2);
        const keys = [...new Set(keysByCommit.flat())];
        const selectedProject = await project();
        const items = await validateHookItems(keys, selectedProject, ["in_progress", "in_review", "done"], async (key) => {
          const detail = await client.query(api.agentApi.detail, { key, workspaceSlug: await workspaceForProject(selectedProject) });
          return detail ? { key, status: detail.item.status } : null;
        });
        return out({ stage, keys }, `Kanban check passed for ${keys.join(", ")}.`);
      }
      throw usage("Use `--stage pre-commit` or `--stage pre-push`.");
    }
    case "auth": {
      if (sub === "whoami") {
        if (!auth?.token) throw new CliError("You are not signed in. Run `kanban login` to open Kanban in your browser.");
        const user = await client.query(api.auth.getCurrentUser, {});
        if (!user) throw new CliError("Your Kanban session expired. Run `kanban login` to sign in again.");
        return out(user, `${user.name ?? "Kanban user"} <${user.email}>`);
      }
      break;
    }
    case "projects": {
      if (sub === "list") {
        const selected = await workspaceFor();
        const ps = await client.query(api.projects.list, selected ? { organizationId: selected.id } : {});
        return out(ps, formatTable(["KEY", "NAME"], ps.map((p) => [p.key, p.name])));
      }
      if (sub === "create") {
        const key = req(flags, "key").toUpperCase();
        const selected = await workspaceFor();
        const createArgs = { name: req(flags, "name"), key, description: str(flags.description) ?? "", organizationId: selected?.id };
        if (dryRun) return dryRunOut([{ action: "projects.create", keys: [], fields: { key, name: createArgs.name, description: createArgs.description } }]);
        await client.mutation(api.projects.create, createArgs);
        return out({ key }, `Created project ${key}`);
      }
      if (sub === "open") {
        const key = (arg ?? await project()).toUpperCase();
        const selected = await client.query(api.projects.getByKey, { key, workspaceSlug: await workspaceForProject(key) });
        if (!selected) throw new CliError(`Project ${key} not found`, 3);
        const target = selected.workspaceSlug ? `${selected.workspaceSlug}/p/${key}/board` : `p/${key}/board`;
        const site = new URL(localSite);
        const url = new URL(target, site).toString();
        openBrowser(url);
        return out({ url }, `Opened ${selected.workspaceSlug ? `${selected.workspaceSlug}/` : ""}${key} in your browser`);
      }
      break;
    }

    case "changelog": {
      const key = (sub ?? await project()).toUpperCase();
      const rows = await client.query(api.changelog.doneItems, { projectKey: key, workspaceSlug: await workspaceForProject(key) });
      if (!rows) throw new CliError(`Project ${key} not found`, 3);
      const md = formatChangelog(key, rows);
      const file = str(flags.write);
      if (file) {
        let existing = "";
        try { existing = readFileSync(file, "utf8"); } catch (e) {
          if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
        }
        writeFileSync(file, withGeneratedChangelog(existing, md));
      }
      return out(rows, file ? `Wrote ${file} (${rows.length} done items)` : md);
    }

    case "git": {
      try {
        const result = await runGit(client, sub, arg, flags, actor);
        return out(result.data, result.human);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/requires|--project|--provider|--repo|--connection|Unknown git/.test(message)) throw usage(message);
        throw e;
      }
    }

    case "gh": {
      if (sub !== "sync" && sub !== "pr" && sub !== "issue") throw usage("Unknown gh command. Supported: sync, pr, issue");
      // --repo, else the repo saved by `kanban link`, else this checkout's origin (your fork, never upstream).
      const repo = str(flags.repo) ?? linkedContext(config)?.github ?? detectGithubRepo();
      if (!repo) throw usage("--repo owner/name is required (no GitHub origin remote found)");
      if (sub === "issue" || sub === "pr") {
        let key: string | undefined = arg?.toUpperCase();
        if (!key) key = await readActiveItem().catch(() => undefined);
        if (!key) {
          try {
            const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
            key = /([A-Za-z][A-Za-z0-9]{1,4}-\d+)/.exec(branch)?.[1]?.toUpperCase();
          } catch { /* not a git checkout */ }
        }
        if (!key || !parseKey(key)) throw usage(`Pass an item key (kanban gh ${sub} WEB-12), set one with kanban hooks set-item, or name the branch after the card.`);
        const d = await client.query(api.agentApi.detail, { key, workspaceSlug: await workspaceForProject(parseKey(key)!.project) });
        if (!d) throw new CliError(`Item ${key} not found`, 3);
        const issue = await findIssue(repo, key);
        if (sub === "issue") {
          if (!issue) throw new CliError(`No GitHub issue mirrors ${key} in ${repo} yet. Run kanban gh sync.`, 3);
          return out({ key, repo, number: issue.number, url: issue.html_url }, issue.html_url);
        }
        const draft = prDraft(d.item, issue, str(flags.body));
        const title = str(flags.title) ?? draft.title;
        const args = ["pr", "create", "--repo", repo, "--title", title, "--body", draft.body];
        if (str(flags.base)) args.push("--base", str(flags.base)!);
        if (flags.draft === true) args.push("--draft");
        if (dryRun) {
          // Opening the PR is an external write, so it is reported, not run.
          const changes: WouldChange[] = [{ action: "gh.pr", project: projectOfKey(key), keys: [key], fields: { repo, title, base: str(flags.base), draft: flags.draft === true } }];
          if (flags.draft !== true) {
            changes.push({ action: "comment.add", keys: [key], fields: { body: `PR opened: ${title} (link added after creation)` } });
            if (["backlog", "todo", "in_progress"].includes(d.item.status)) changes.push({ action: "items.move", keys: [key], fields: { status: "in_review" } });
          }
          return dryRunOut(changes);
        }
        let url: string;
        try {
          url = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop()!;
        } catch (e) {
          const err = e as { stderr?: string };
          throw new CliError(`gh pr create failed: ${(err.stderr ?? String(e)).trim()}`);
        }
        const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        const event = flags.draft === true ? undefined : "open";
        await client.mutation(api.comments.add, { workItemId: d.item._id, author: actor, body: `PR #${number} opened: ${draft.title} ${url}${event ? ` (gh-pr:${number}:${event})` : ""}` });
        if (event && ["backlog", "todo", "in_progress"].includes(d.item.status)) {
          await client.mutation(api.workItems.move, { id: d.item._id, actor, status: "in_review" });
        }
        return out({ key, repo, url, number, issue: issue?.number }, `${url}${event ? `\n${key} → in_review` : ""}`);
      }
      const pk = await project();
      const workspaceSlug = await workspaceForProject(pk);
      const lines: string[] = [];
      const report = await syncGithub(client, {
        projectKey: pk,
        workspaceSlug,
        repo,
        actor,
        boardUrl: str(flags["board-url"]) ?? linkedContext(config)?.boardUrl,
        dryRun,
        includeDone: flags["include-done"] === true,
        comments: flags["no-comments"] !== true,
        relink: flags.relink === true,
        prs: flags["no-prs"] !== true,
        log: (line) => { lines.push(line); if (!json) console.error(line); },
      });
      return out({ repo, project: pk, dryRun, ...report, plan: dryRun ? lines : undefined }, `${pk} ⇄ ${repo}\n${formatReport(report, dryRun)}`);
    }

    case "tree": {
      const key = (sub ?? await project()).toUpperCase();
      const rows = await client.query(api.agentApi.tree, { projectKey: key, workspaceSlug: await workspaceForProject(key) });
      if (!rows) throw new CliError(`Project ${key} not found`, 3);
      return out(rows, formatTree(rows));
    }

    case "items": {
      if (sub === "list") {
        const limit = num(flags.limit, "limit");
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
          throw usage("--limit must be a whole number from 1 to 100");
        }
        const allRows = await client.query(api.agentApi.search, {
          projectKey: await project(),
          workspaceSlug: await workspaceForProject(await project()),
          q: str(flags.q),
          status: str(flags.status) as never,
          assignee: str(flags.assignee),
          type: str(flags.type) as never,
          epicKey: str(flags.epic),
          limit,
        });
        const rows = allRows;
        const data = flags.compact === true ? compactItems(rows) : rows;
        return out(data, rows.length ? formatTable(["KEY", "TYPE", "STATUS", "ASSIGNEE", "TITLE"], rows.map((r) => [r.key, r.type, r.status, r.assignee ?? "-", r.title])) : "(no items)");
      }
      if (sub === "get") {
        const key = need(arg, "item key");
        const d = await client.query(api.agentApi.detail, { key, workspaceSlug: await workspaceForProject(parseKey(key)?.project ?? await project()) });
        if (!d) throw new CliError(`Item ${key.toUpperCase()} not found`, 3);
        const i = d.item;
        const human = [
          `${[...d.breadcrumb.map((b) => b.key), i.key].join(" › ")}  [${i.type}] ${i.title}`,
          `status=${i.status} priority=${i.priority} assignee=${i.assignee ?? "-"} points=${i.points ?? "-"} due=${i.dueDate ?? "-"}`,
          d.dependsOnKeys.length ? `depends on: ${d.dependsOnKeys.join(", ")}` : "",
          i.description ? `\n${i.description}` : "",
          d.children.length ? `\nChildren:\n${d.children.map((c) => `  ${c.key} [${c.type}] ${c.title} (${c.status})${c.assignee ? ` @${c.assignee}` : ""}`).join("\n")}` : "",
          d.comments.length ? `\nComments:\n${d.comments.map((c) => `  ${c.author}: ${c.body}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
        return out(d, human);
      }
      if (sub === "create") {
        const pk = await project();
        const p = await client.query(api.projects.getByKey, { key: pk, workspaceSlug: await workspaceForProject(pk) });
        if (!p) throw new CliError(`Project ${pk} not found`, 3);
        const createArgs = {
          projectId: p._id,
          actor,
          type: req(flags, "type") as never,
          title: req(flags, "title"),
          description: str(flags.description),
          parentId: flags.parent ? await idOf(req(flags, "parent")) : undefined,
          status: str(flags.status) as never,
          priority: str(flags.priority) as never,
          assignee: str(flags.assignee),
          labels: flags.labels === undefined ? undefined : splitList(str(flags.labels)),
          points: num(flags.points, "points"),
          startDate: str(flags.start),
          dueDate: str(flags.due),
          sprintId: flags.sprint ? await sprintOf(req(flags, "sprint"), pk) : undefined,
        };
        if (dryRun) return dryRunOut([{ action: "items.create", project: pk, keys: flags.parent ? [req(flags, "parent").toUpperCase()] : [], fields: flagFields(flags, CREATE_FLAGS) }]);
        const id = await client.mutation(api.workItems.create, createArgs);
        const created = (await client.query(api.workItems.listByProject, { projectId: p._id })).find((x) => x._id === id);
        return out({ id, key: created?.key }, `Created ${created?.key}`);
      }
      if (sub === "update") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        const nullable = (name: string) => (flags[name] === undefined ? undefined : str(flags[name]) === "none" ? null : str(flags[name])!);
        const patch: Record<string, unknown> = {
          title: str(flags.title),
          description: str(flags.description),
          type: str(flags.type),
          status: str(flags.status),
          priority: str(flags.priority),
          assignee: nullable("assignee"),
          startDate: nullable("start"),
          dueDate: nullable("due"),
          labels: flags.labels === undefined ? undefined : splitList(str(flags.labels)),
          points: flags.points === undefined ? undefined : str(flags.points) === "none" ? null : num(flags.points, "points"),
          parentId: flags.parent === undefined ? undefined : str(flags.parent) === "none" ? null : await idOf(req(flags, "parent")),
          dependsOn: flags["depends-on"] === undefined ? undefined : await idsOf(splitList(str(flags["depends-on"]) === "none" ? "" : str(flags["depends-on"]))),
          sprintId: flags.sprint === undefined ? undefined : str(flags.sprint) === "none" ? null : await sprintOf(req(flags, "sprint"), projectOfKey(key)),
        };
        for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
        if (Object.keys(patch).length === 0) throw usage("Nothing to update — pass at least one field flag");
        if (dryRun) return dryRunOut([{ action: "items.update", keys: [key.toUpperCase()], fields: flagFields(flags, UPDATE_FLAGS) }]);
        await client.mutation(api.workItems.update, { id, actor, ...patch } as never);
        return out({ key: key.toUpperCase(), updated: Object.keys(patch) }, `Updated ${key.toUpperCase()} (${Object.keys(patch).join(", ")})`);
      }
      if (sub === "move") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        const moveArgs = {
          id, actor,
          status: req(flags, "status") as never,
          afterId: flags.after ? await idOf(req(flags, "after")) : undefined,
          beforeId: flags.before ? await idOf(req(flags, "before")) : undefined,
        };
        if (dryRun) return dryRunOut([{ action: "items.move", keys: [key.toUpperCase()], fields: flagFields(flags, ["status", "after", "before"]) }]);
        await client.mutation(api.workItems.move, moveArgs);
        return out({ key: key.toUpperCase(), status: flags.status }, `Moved ${key.toUpperCase()} to ${flags.status}`);
      }
      if (sub === "rm") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        if (flags.yes !== true) {
          const rows = await client.query(api.agentApi.search, { projectKey: projectOfKey(key), epicKey: key, workspaceSlug: await workspaceForProject(projectOfKey(key)) });
          throw usage(`Refusing to delete ${key.toUpperCase()} and its subtree (${rows.length} item(s)) without --yes`);
        }
        if (dryRun) {
          const rows = await client.query(api.agentApi.search, { projectKey: projectOfKey(key), epicKey: key, workspaceSlug: await workspaceForProject(projectOfKey(key)) });
          const subtree = [...new Set([key.toUpperCase(), ...rows.map((row: { key: string }) => row.key)])];
          return dryRunOut([{ action: "items.rm", project: projectOfKey(key), keys: subtree }]);
        }
        const r = await client.mutation(api.workItems.remove, { id, actor });
        return out(r, `Deleted ${r.deleted} item(s)`);
      }
      if (sub === "breakdown") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        const text = str(flags.text) ?? (await readStdin());
        if (!text.trim()) throw usage("Provide --text or pipe one item per line on stdin");
        if (dryRun) return dryRunOut([{ action: "items.breakdown", keys: [key.toUpperCase()], fields: { text } }]);
        const r = await client.mutation(api.workItems.breakdown, { parentId: id, actor, text });
        return out(r, `Created ${r.created.length} child item(s) under ${key.toUpperCase()}`);
      }
      if (sub === "distribute") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        const people = splitList(str(flags.people));
        if (dryRun) return dryRunOut([{ action: "items.distribute", keys: [key.toUpperCase()], fields: { people } }]);
        const r = await client.mutation(api.workItems.distribute, { parentId: id, actor, people });
        return out(r, `Assigned ${r.assigned} child item(s)`);
      }
      if (sub === "bulk") {
        const keys = splitList(str(flags.ids));
        if (keys.length === 0) throw usage("--ids WEB-1,WEB-2 is required");
        const ids = await idsOf(keys);
        const pk = projectOfKey(keys[0]);
        const bulkArgs = {
          ids, actor,
          status: str(flags.status) as never,
          priority: str(flags.priority) as never,
          assignee: flags.assignee === undefined ? undefined : str(flags.assignee) === "none" ? null : str(flags.assignee)!,
          sprintId: flags.sprint === undefined ? undefined : str(flags.sprint) === "none" ? null : await sprintOf(req(flags, "sprint"), pk),
        };
        if (dryRun) return dryRunOut([{ action: "items.bulk", project: pk, keys: keys.map((k) => k.toUpperCase()), fields: flagFields(flags, ["status", "priority", "assignee", "sprint"]) }]);
        const n = await client.mutation(api.workItems.bulkUpdate, bulkArgs);
        return out({ updated: n }, `Updated ${n} item(s)`);
      }
      break;
    }

    case "comment": {
      const key = need(arg, "item key");
      const id = await idOf(key);
      if (sub === "add") {
        const body = str(flags.body) ?? (await readStdin());
        if (dryRun) return dryRunOut([{ action: "comment.add", keys: [key.toUpperCase()], fields: { body } }]);
        await client.mutation(api.comments.add, { workItemId: id, author: actor, body });
        return out({ key: key.toUpperCase() }, `Commented on ${key.toUpperCase()}`);
      }
      if (sub === "list") {
        const cs = await client.query(api.comments.listForItem, { workItemId: id });
        return out(cs, cs.length ? cs.map((c) => `${c.author}: ${c.body}`).join("\n") : "(no comments)");
      }
      break;
    }

    case "sprints": {
      const pk = await project();
      const p = await client.query(api.projects.getByKey, { key: pk, workspaceSlug: await workspaceForProject(pk) });
      if (!p) throw new CliError(`Project ${pk} not found`, 3);
      if (sub === "list") {
        const ss = await client.query(api.sprints.listByProject, { projectId: p._id });
        return out(ss, ss.length ? formatTable(["NAME", "STATE", "START", "END"], ss.map((s) => [s.name, s.state, s.startDate ?? "-", s.endDate ?? "-"])) : "(no sprints)");
      }
      if (sub === "create") {
        const createArgs = { projectId: p._id, name: req(flags, "name"), goal: str(flags.goal) ?? "", startDate: str(flags.start), endDate: str(flags.end) };
        if (dryRun) return dryRunOut([{ action: "sprints.create", project: pk, keys: [], fields: flagFields(flags, ["name", "goal", "start", "end"]) }]);
        await client.mutation(api.sprints.create, createArgs);
        return out({ name: flags.name }, `Created sprint ${flags.name}`);
      }
      if (sub === "start" || sub === "complete") {
        const sprintId = await sprintOf(need(arg, "sprint name or id"), pk);
        if (dryRun) return dryRunOut([{ action: `sprints.${sub}`, project: pk, keys: [], fields: { sprint: arg } }]);
        await client.mutation(sub === "start" ? api.sprints.start : api.sprints.complete, { sprintId });
        return out({ sprint: arg, state: sub === "start" ? "active" : "completed" }, `Sprint ${arg} ${sub === "start" ? "started" : "completed"}`);
      }
      break;
    }
  }
  throw usage(`Unknown command: ${pos.join(" ")}. Run 'kanban agent-help'.`);
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function req(flags: Parsed["flags"], name: string): string {
  const v = str(flags[name]);
  if (v === undefined || v === "") throw usage(`--${name} is required`);
  return v;
}
function need(v: string | undefined, what: string): string {
  if (!v) throw usage(`Missing ${what}`);
  return v;
}
function num(v: string | true | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== "string" || v === "" || !Number.isFinite(n)) throw usage(`--${name} must be a number`);
  return n;
}
const STDIN_TIMEOUT_MS = 10_000;
/** Only called when --text/--body is absent. A TTY means nothing was piped. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return readAll(process.stdin, STDIN_TIMEOUT_MS);
}

/** Run only when executed as the CLI (the npm bin is a symlink, so compare real paths). Tests import this module. */
const isEntrypoint = (() => {
  try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isEntrypoint) main(process.argv.slice(2)).then(async () => {
  const argv = process.argv.slice(2);
  if (shouldShowUpdateNotice({ stdoutIsTTY: process.stdout.isTTY, command: argv })) {
    try {
      const result = await checkForUpdate();
      if (result.updateAvailable) process.stderr.write(`Update available: ${result.current} → ${result.latest}. Run: ${updateInstallCommand()}\n`);
    } catch { /* Update checks never affect command behavior. */ }
  }
}).catch((e) => {
  const json = process.argv.includes("--json");
  let message = e instanceof CliError || e instanceof UsageError ? e.message : cleanServerError(e);
  if (/unauthenticated|not authenticated|invalid auth token|invalid jwt/i.test(message)) {
    message += "\nSign in or refresh this device with `kanban login`, then retry.";
  }
  const code = e instanceof CliError ? e.code : e instanceof UsageError ? 2 : classifyError(message);
  if (json) console.error(JSON.stringify({ error: message, code }));
  else console.error(`error: ${message}`);
  process.exit(code);
});
