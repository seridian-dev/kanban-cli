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
import { browserLogin, clearToken, readAuth } from "./auth.js";
import { gitRoot, linkedProject, readConfig, writeConfig } from "./config.js";
import { formatChangelog, withGeneratedChangelog } from "./changelog.js";
import { runGit } from "./git.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyError, compactItems, formatTable, formatTree, parseArgs, parseKey, pickSprint, readAll, splitList, UsageError, type Parsed } from "./lib.js";

class CliError extends Error {
  constructor(message: string, readonly code: 1 | 2 | 3 = 1) {
    super(message);
  }
}

const usage = (m: string) => new CliError(m, 2);

function cleanServerError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /Uncaught Error: ([^\n]+?)(?: at | Called by|$|\n)/.exec(raw);
  return (m?.[1] ?? raw.split("\n")[0]).trim();
}

async function main(argv: string[]) {
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

  const [group, sub, arg] = pos;
  const config = await readConfig();
  const auth = await readAuth();
  const localSite = str(flags.url) ?? process.env.KANBAN_URL ?? config.site ?? auth?.site ?? DEFAULT_KANBAN_URL;
  if (pos[0] === "config") {
    if (!sub || sub === "show") return out(config, `Site: ${config.site ?? DEFAULT_KANBAN_URL}\nUser: ${config.user ?? "not set"}\nDefault project: ${config.project ?? "not set"}\nProject links: ${config.links?.length ?? 0}\nConfig: ~/.config/kanban/config.json (no credentials stored here)`);
    if (sub === "set") {
      const name = arg;
      const value = pos[3] ?? str(flags.value);
      if (!name || !value) throw usage("Use `kanban config set site|user|project VALUE`");
      if (name === "site") {
        if (/\.convex\.(cloud|site)(\/|$)/.test(value)) throw usage("Set the Kanban website URL, such as https://kanban.seridian.dev.");
        config.site = new URL(value).origin;
      } else if (name === "user") config.user = value;
      else if (name === "project") config.project = value.toUpperCase();
      else throw usage("Config keys are site, user, or project.");
      await writeConfig(config);
      return out(config, `Saved ${name} in ~/.config/kanban/config.json`);
    }
    throw usage("Use `kanban config [show]` or `kanban config set site|user|project VALUE`");
  }
  if (pos[0] === "link") {
    const projectKey = str(flags.project)?.toUpperCase();
    if (!projectKey || !/^[A-Z][A-Z0-9]{1,4}$/.test(projectKey)) throw usage("Use `kanban link --project KEY [--path .]`; KEY is a project key like KAN.");
    const path = resolve(str(flags.path) ?? gitRoot());
    config.links = [...(config.links ?? []).filter((link) => resolve(link.path) !== path), { path, project: projectKey }];
    await writeConfig(config);
    return out({ path, project: projectKey }, `Linked ${path} to ${projectKey}. Nested folders use this project unless they have a more specific link.`);
  }
  if (pos[0] === "links") {
    if (sub === "list" || !sub) return out(config.links ?? [], (config.links?.length ? config.links.map((link) => `${link.project}  ${link.path}`).join("\n") : "No local project links yet. Run `kanban link --project KEY` inside a repo."));
    if (sub === "remove" || sub === "unlink") {
      const path = resolve(str(flags.path) ?? gitRoot());
      const before = config.links?.length ?? 0;
      config.links = (config.links ?? []).filter((link) => resolve(link.path) !== path);
      await writeConfig(config);
      return out({ removed: before - (config.links?.length ?? 0), path }, `Removed local project link for ${path}`);
    }
    throw usage("Use `kanban links list` or `kanban links remove [--path .]`");
  }
  if (pos[0] === "context") {
    let root: string | undefined;
    try { root = gitRoot(); } catch { /* Linking a plain folder is supported. */ }
    const mapping = linkedProject(config);
    const effectiveProject = str(flags.project)?.toUpperCase() ?? process.env.KANBAN_PROJECT?.toUpperCase() ?? mapping ?? config.project;
    const context = { folder: process.cwd(), gitRoot: root, linkedProject: mapping, project: effectiveProject };
    return out(context, `Folder: ${context.folder}\nGit repo: ${root ?? "none"}\nLinked project: ${mapping ?? "none"}\nActive project: ${effectiveProject ?? "not set"}`);
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

  const endpoint = localSite;
  let url: string;
  try { url = await resolveBackendUrl(endpoint); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error)); }
  const client = new ConvexHttpClient(url) as unknown as CliConvexClient;
  if (auth?.token) (client as unknown as ConvexHttpClient).setAuth(auth.token);
  const actor = str(flags.as) ?? process.env.KANBAN_USER ?? config.user ?? "cli";
  const project = () => {
    const p = str(flags.project) ?? process.env.KANBAN_PROJECT ?? linkedProject(config) ?? config.project;
    if (!p) throw usage("--project KEY is required. Or link this folder with `kanban link --project KEY`.");
    return p.toUpperCase();
  };

  const idOf = async (key: string): Promise<Id<"workItems">> => {
    if (!parseKey(key)) throw usage(`"${key}" is not an item key like KAN-12`);
    const item = await client.query(api.agentApi.getByKey, { key });
    if (!item) throw new CliError(`Item ${key.toUpperCase()} not found`, 3);
    return item._id;
  };
  const idsOf = async (keys: string[]) => Promise.all(keys.map(idOf));

  const sprintOf = async (ref: string, projectKey: string): Promise<Id<"sprints">> => {
    const p = await client.query(api.projects.getByKey, { key: projectKey });
    if (!p) throw new CliError(`Project ${projectKey} not found`, 3);
    const sprints = await client.query(api.sprints.listByProject, { projectId: p._id });
    const hit = pickSprint(sprints, ref);
    if (!hit) throw new CliError(`Sprint "${ref}" not found in ${projectKey}`, 3);
    return hit._id as Id<"sprints">;
  };
  const projectOfKey = (key: string) => parseKey(key)!.project;

  switch (group) {
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
        const ps = await client.query(api.projects.list, {});
        return out(ps, formatTable(["KEY", "NAME"], ps.map((p) => [p.key, p.name])));
      }
      if (sub === "create") {
        const key = req(flags, "key").toUpperCase();
        await client.mutation(api.projects.create, { name: req(flags, "name"), key, description: str(flags.description) ?? "" });
        return out({ key }, `Created project ${key}`);
      }
      break;
    }

    case "changelog": {
      const key = (sub ?? project()).toUpperCase();
      const rows = await client.query(api.changelog.doneItems, { projectKey: key });
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

    case "tree": {
      const key = (sub ?? project()).toUpperCase();
      const rows = await client.query(api.agentApi.tree, { projectKey: key });
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
          projectKey: project(),
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
        const d = await client.query(api.agentApi.detail, { key });
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
        const pk = project();
        const p = await client.query(api.projects.getByKey, { key: pk });
        if (!p) throw new CliError(`Project ${pk} not found`, 3);
        const id = await client.mutation(api.workItems.create, {
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
        });
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
        await client.mutation(api.workItems.update, { id, actor, ...patch } as never);
        return out({ key: key.toUpperCase(), updated: Object.keys(patch) }, `Updated ${key.toUpperCase()} (${Object.keys(patch).join(", ")})`);
      }
      if (sub === "move") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        await client.mutation(api.workItems.move, {
          id, actor,
          status: req(flags, "status") as never,
          afterId: flags.after ? await idOf(req(flags, "after")) : undefined,
          beforeId: flags.before ? await idOf(req(flags, "before")) : undefined,
        });
        return out({ key: key.toUpperCase(), status: flags.status }, `Moved ${key.toUpperCase()} to ${flags.status}`);
      }
      if (sub === "rm") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        if (flags.yes !== true) {
          const rows = await client.query(api.agentApi.search, { projectKey: projectOfKey(key), epicKey: key });
          throw usage(`Refusing to delete ${key.toUpperCase()} and its subtree (${rows.length} item(s)) without --yes`);
        }
        const r = await client.mutation(api.workItems.remove, { id, actor });
        return out(r, `Deleted ${r.deleted} item(s)`);
      }
      if (sub === "breakdown") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        const text = str(flags.text) ?? (await readStdin());
        if (!text.trim()) throw usage("Provide --text or pipe one item per line on stdin");
        const r = await client.mutation(api.workItems.breakdown, { parentId: id, actor, text });
        return out(r, `Created ${r.created.length} child item(s) under ${key.toUpperCase()}`);
      }
      if (sub === "distribute") {
        const key = need(arg, "item key");
        const id = await idOf(key);
        const r = await client.mutation(api.workItems.distribute, { parentId: id, actor, people: splitList(str(flags.people)) });
        return out(r, `Assigned ${r.assigned} child item(s)`);
      }
      if (sub === "bulk") {
        const keys = splitList(str(flags.ids));
        if (keys.length === 0) throw usage("--ids KAN-1,KAN-2 is required");
        const ids = await idsOf(keys);
        const pk = projectOfKey(keys[0]);
        const n = await client.mutation(api.workItems.bulkUpdate, {
          ids, actor,
          status: str(flags.status) as never,
          priority: str(flags.priority) as never,
          assignee: flags.assignee === undefined ? undefined : str(flags.assignee) === "none" ? null : str(flags.assignee)!,
          sprintId: flags.sprint === undefined ? undefined : str(flags.sprint) === "none" ? null : await sprintOf(req(flags, "sprint"), pk),
        });
        return out({ updated: n }, `Updated ${n} item(s)`);
      }
      break;
    }

    case "comment": {
      const key = need(arg, "item key");
      const id = await idOf(key);
      if (sub === "add") {
        const body = str(flags.body) ?? (await readStdin());
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
      const pk = project();
      const p = await client.query(api.projects.getByKey, { key: pk });
      if (!p) throw new CliError(`Project ${pk} not found`, 3);
      if (sub === "list") {
        const ss = await client.query(api.sprints.listByProject, { projectId: p._id });
        return out(ss, ss.length ? formatTable(["NAME", "STATE", "START", "END"], ss.map((s) => [s.name, s.state, s.startDate ?? "-", s.endDate ?? "-"])) : "(no sprints)");
      }
      if (sub === "create") {
        await client.mutation(api.sprints.create, { projectId: p._id, name: req(flags, "name"), goal: str(flags.goal) ?? "", startDate: str(flags.start), endDate: str(flags.end) });
        return out({ name: flags.name }, `Created sprint ${flags.name}`);
      }
      if (sub === "start" || sub === "complete") {
        const sprintId = await sprintOf(need(arg, "sprint name or id"), pk);
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

main(process.argv.slice(2)).catch((e) => {
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
