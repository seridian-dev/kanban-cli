/**
 * `kanban gh sync` — two-way sync between a Kanban project and GitHub issues, using the gh CLI.
 *
 * Kanban is ground truth:
 *  - Kanban → GitHub: title, body, labels, milestone (sprint) and open/closed state are pushed and
 *    overwrite GitHub edits. Done items close their issue; other statuses keep it open.
 *  - GitHub → Kanban: issues opened on GitHub without a marker become Kanban tasks (or bugs);
 *    GitHub comments are copied onto the card; an issue closed on GitHub while its card is still open
 *    moves the card to in_review (a person confirms done) instead of being reopened.
 * Each mirrored issue body carries `<!-- kanban:KEY -->`, so no local state file is needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { api } from "./api.js";
import type { CliConvexClient } from "./client.js";

const exec = promisify(execFile);

export const MARKER_RE = /<!-- kanban:([A-Z][A-Z0-9]*-\d+) -->/;
export const GH_COMMENT_RE = /\(gh-comment:(\d+)\)/;
export const KANBAN_COMMENT_RE = /<!-- kanban-comment:([^ ]+) -->/;
const SYNC_NOTE = "<!-- kanban-sync -->";

export type Status = "backlog" | "todo" | "in_progress" | "in_review" | "done";

export interface SyncItem {
  _id: string;
  key: string;
  type: string;
  status: Status;
  title: string;
  description?: string;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  points?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  parentId?: string | null;
  dependsOn?: string[];
  sprintId?: string | null;
  number: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  milestone: { number: number } | null;
  comments: number;
  html_url: string;
  user?: { login: string };
  pull_request?: unknown;
}

export const markerFor = (key: string) => `<!-- kanban:${key} -->`;
export const PR_MARKER_RE = /\(gh-pr:(\d+):(open|merged)\)/g;

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  html_url: string;
  head: { ref: string };
}

const CLOSING_VERB = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

/**
 * Card keys a pull request delivers: keys in its title or branch name, and keys or issues after a
 * closing word in the body ("Closes #28", "Fixes PP-55"). Keys merely mentioned in the body don't count.
 */
export function prKeys(pr: Pick<PullRequest, "title" | "body" | "head">, projectKey: string, keyByIssue: Map<number, string>): string[] {
  const keyRe = new RegExp(`\\b${projectKey}-(\\d+)\\b`, "gi");
  const keys = [...`${pr.title}\n${pr.head.ref}`.matchAll(keyRe)].map((m) => `${projectKey}-${m[1]}`);
  const closing = new RegExp(`\\b${CLOSING_VERB}:?\\s+(?:#(\\d+)|${projectKey}-(\\d+))\\b`, "gi");
  for (const m of (pr.body ?? "").matchAll(closing)) {
    const key = m[1] ? keyByIssue.get(Number(m[1])) : `${projectKey}-${m[2]}`;
    if (key) keys.push(key.toUpperCase());
  }
  return [...new Set(keys)];
}

export const prState = (pr: Pick<PullRequest, "state" | "merged_at" | "draft">): "open" | "draft" | "merged" | "closed" =>
  pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
export const parseMarker = (body: string | null | undefined) => MARKER_RE.exec(body ?? "")?.[1];
const TITLE_KEY_RE = /^\[([A-Z][A-Z0-9]*-\d+)\] /;
/** Which Kanban card an issue mirrors: the body marker, else a "[KEY] title" prefix from older mirrors. */
export const issueKey = (issue: Pick<Issue, "body" | "title">) => parseMarker(issue.body) ?? TITLE_KEY_RE.exec(issue.title)?.[1];

const TYPE_COLORS: Record<string, string> = { epic: "5319e7", story: "1d76db", task: "0e8a16", bug: "d73a4a", subtask: "c5def5" };
const PRIORITY_COLORS: Record<string, string> = { urgent: "b60205", high: "d93f0b", medium: "fbca04", low: "c2e0c6" };

/** Labels an item's issue should carry. */
export function labelsFor(item: SyncItem): string[] {
  const out = ["kanban", `type: ${item.type}`];
  if (item.priority && PRIORITY_COLORS[item.priority]) out.push(`priority: ${item.priority}`);
  if (item.status === "in_progress") out.push("status: in progress");
  if (item.status === "in_review") out.push("status: in review");
  for (const l of item.labels ?? []) out.push(`area: ${l}`);
  return [...new Set(out)];
}

export function labelColor(name: string): string {
  if (name.startsWith("type: ")) return TYPE_COLORS[name.slice(6)] ?? "ededed";
  if (name.startsWith("priority: ")) return PRIORITY_COLORS[name.slice(10)] ?? "ededed";
  if (name.startsWith("status: ")) return "0052cc";
  if (name.startsWith("area: ")) return "bfd4f2";
  return "ededed";
}

/** Split "context. AC: a; b; c" descriptions into context and acceptance-criteria checkboxes. */
export function splitAcceptance(description: string | undefined): { context: string; criteria: string[] } {
  const text = (description ?? "").trim();
  const at = text.indexOf("AC: ");
  if (at < 0) return { context: text, criteria: [] };
  const criteria = text.slice(at + 4).split(";").map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
  return { context: text.slice(0, at).trim(), criteria };
}

export interface BodyContext {
  boardUrl?: string;
  keyById: Map<string, SyncItem>;
  issueByKey: Map<string, Issue>;
  children: SyncItem[];
  sprintName?: string;
  pulls?: PullRequest[];
}

const ref = (key: string, ctx: BodyContext) => {
  const issue = ctx.issueByKey.get(key);
  return issue ? `#${issue.number} (${key})` : key;
};

/** The issue body Kanban owns. Everything here is overwritten on each sync. */
export function renderBody(item: SyncItem, ctx: BodyContext): string {
  const lines: string[] = [];
  lines.push(`> Synced from Kanban **${item.key}**${ctx.boardUrl ? ` · [board](${ctx.boardUrl})` : ""}. Kanban is the source of truth: edit the card, not this issue body.`, "");
  const parent = item.parentId ? ctx.keyById.get(item.parentId) : undefined;
  if (parent) lines.push(`**Parent:** ${ref(parent.key, ctx)} ${parent.title}`);
  const meta = [`**Type:** ${item.type}`, `**Status:** ${item.status}`];
  if (item.priority) meta.push(`**Priority:** ${item.priority}`);
  if (item.points) meta.push(`**Points:** ${item.points}`);
  if (item.startDate || item.dueDate) meta.push(`**Dates:** ${item.startDate ?? "?"} → ${item.dueDate ?? "?"}`);
  if (ctx.sprintName) meta.push(`**Sprint:** ${ctx.sprintName}`);
  if (item.assignee) meta.push(`**Assignee (Kanban):** ${item.assignee}`);
  lines.push(meta.join(" · "), "");
  const { context, criteria } = splitAcceptance(item.description);
  if (context) lines.push("## Context", "", context, "");
  if (criteria.length) lines.push("## Acceptance criteria", "", ...criteria.map((c) => `- [ ] ${c}`), "");
  const deps = (item.dependsOn ?? []).map((id) => ctx.keyById.get(id)).filter((d): d is SyncItem => !!d);
  if (deps.length) lines.push("## Depends on", "", ...deps.map((d) => `- [${d.status === "done" ? "x" : " "}] ${ref(d.key, ctx)} ${d.title}`), "");
  if (ctx.pulls?.length) lines.push("## Pull requests", "", ...ctx.pulls.map((p) => `- [${prState(p) === "merged" ? "x" : " "}] #${p.number} ${p.title} (${prState(p)})`), "");
  if (ctx.children.length) lines.push("## Children", "", ...ctx.children.map((c) => `- [${c.status === "done" ? "x" : " "}] ${ref(c.key, ctx)} ${c.title}`), "");
  lines.push(markerFor(item.key));
  return lines.join("\n");
}

/** What GitHub state an item wants, given what GitHub has now. in_review never forces a reopen. */
export function desiredState(status: Status, current: "open" | "closed"): "open" | "closed" {
  if (status === "done") return "closed";
  if (status === "in_review" && current === "closed") return "closed";
  return "open";
}

/** GitHub → Kanban for state: a closed issue whose card is still open sends the card to review. */
export function closedOnGithub(item: SyncItem, issue: Issue): boolean {
  return issue.state === "closed" && item.status !== "done" && item.status !== "in_review";
}

// ---------------------------------------------------------------------------------------------
// gh CLI wrapper

export type Gh = (args: string[], input?: unknown) => Promise<any>;

export const ghCli: Gh = async (args, input) => {
  const child = execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  const done = new Promise<string>((resolve, reject) => {
    let out = "", err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${err.trim() || out.trim()}`))));
  });
  if (input !== undefined) child.stdin?.end(JSON.stringify(input));
  else child.stdin?.end();
  const out = await done;
  if (!out.trim()) return {};
  // --paginate --slurp returns an array of pages.
  return JSON.parse(out);
};

const apiCall = (gh: Gh, method: string, path: string, body?: unknown) =>
  gh(["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], body);

async function paginate(gh: Gh, path: string): Promise<any[]> {
  const pages = await gh(["api", "--paginate", "--slurp", path]);
  return (Array.isArray(pages) ? pages : [pages]).flat();
}

export async function checkGh(gh: Gh = ghCli) {
  void gh;
  try { await exec("gh", ["--version"]); } catch { throw new Error("gh CLI not found. Install it from https://cli.github.com and run `gh auth login`."); }
}

// ---------------------------------------------------------------------------------------------
// The sync

export interface SyncOptions {
  projectKey: string;
  workspaceSlug?: string;
  repo: string;
  actor: string;
  boardUrl?: string;
  dryRun: boolean;
  includeDone: boolean;
  comments: boolean;
  relink: boolean;
  /** Read pull requests: link them on issues and cards, and move cards with an open PR to in_review. */
  prs?: boolean;
  log: (line: string) => void;
}

export interface SyncReport {
  created: string[];
  updated: string[];
  closed: string[];
  reopened: string[];
  importedFromGithub: string[];
  movedToReview: string[];
  commentsToKanban: number;
  commentsToGithub: number;
  linked: number;
  prLinks: string[];
}

export async function syncGithub(client: CliConvexClient, opts: SyncOptions, gh: Gh = ghCli): Promise<SyncReport> {
  const report: SyncReport = { created: [], updated: [], closed: [], reopened: [], importedFromGithub: [], movedToReview: [], commentsToKanban: 0, commentsToGithub: 0, linked: 0, prLinks: [] };
  const R = opts.repo;
  if (!/^[\w.-]+\/[\w.-]+$/.test(R)) throw new Error("--repo must look like owner/name");
  await checkGh(gh);
  const repoInfo = await apiCall(gh, "GET", `repos/${R}`);
  if (!repoInfo.has_issues) throw new Error(`Issues are disabled on ${R}. Enable them (gh repo edit ${R} --enable-issues) and retry.`);

  const project = await client.query(api.projects.getByKey, { key: opts.projectKey, workspaceSlug: opts.workspaceSlug });
  if (!project) throw new Error(`Project ${opts.projectKey} not found`);
  let items: SyncItem[] = await client.query(api.workItems.listByProject, { projectId: project._id });
  const sprints: { _id: string; name: string; goal?: string; endDate?: string }[] = await client.query(api.sprints.listByProject, { projectId: project._id });

  const issues: Issue[] = (await paginate(gh, `repos/${R}/issues?state=all&per_page=100`)).filter((i: Issue) => !i.pull_request);
  const issueByKey = new Map<string, Issue>();
  for (const i of issues) {
    const k = issueKey(i);
    if (k && k.startsWith(opts.projectKey + "-")) issueByKey.set(k, i);
  }

  // GitHub → Kanban: issues opened on GitHub with no marker become cards.
  const stray = issues.filter((i) => i.state === "open" && !issueKey(i) && !i.labels.some((l) => l.name === "kanban-ignore"));
  for (const i of stray) {
    const isBug = i.labels.some((l) => l.name === "bug");
    opts.log(`import #${i.number} ${i.title}`);
    if (opts.dryRun) continue;
    const id = await client.mutation(api.workItems.create, {
      projectId: project._id,
      actor: opts.actor,
      type: isBug ? "bug" : "task",
      title: i.title,
      description: `${(i.body ?? "").trim()}\n\nOpened on GitHub by @${i.user?.login ?? "unknown"}: ${i.html_url}`.trim(),
      status: "backlog",
      labels: ["github", ...i.labels.map((l) => l.name).filter((n) => !/^(kanban|type: |priority: |status: |area: )/.test(n))].slice(0, 10),
    });
    items = await client.query(api.workItems.listByProject, { projectId: project._id });
    const created = items.find((x) => x._id === id);
    if (!created) continue;
    const body = `${(i.body ?? "").trim()}\n\n${markerFor(created.key)}`;
    await apiCall(gh, "PATCH", `repos/${R}/issues/${i.number}`, { body });
    i.body = body;
    issueByKey.set(created.key, i);
    report.importedFromGithub.push(`${created.key} ← #${i.number}`);
  }

  // GitHub → Kanban: closed on GitHub while the card is open → in_review, with a note.
  const itemByKey = new Map(items.map((x) => [x.key, x]));
  for (const [key, issue] of issueByKey) {
    const item = itemByKey.get(key);
    if (!item || !closedOnGithub(item, issue)) continue;
    opts.log(`review ${key} (closed on GitHub as #${issue.number})`);
    if (opts.dryRun) continue;
    await client.mutation(api.workItems.move, { id: item._id, actor: opts.actor, status: "in_review" });
    await client.mutation(api.comments.add, { workItemId: item._id, author: opts.actor, body: `GitHub issue #${issue.number} was closed (${issue.html_url}). Moved to in_review; mark done in Kanban once verified.` });
    item.status = "in_review";
    report.movedToReview.push(key);
  }

  // GitHub → Kanban: pull requests that name a card. An open PR moves the card to review; nothing moves to done.
  const pullsByKey = new Map<string, PullRequest[]>();
  if (opts.prs !== false) {
    const keyByIssue = new Map([...issueByKey].map(([k, i]) => [i.number, k]));
    const pulls: PullRequest[] = await gh(["api", `repos/${R}/pulls?state=all&sort=updated&direction=desc&per_page=100`]);
    for (const pr of Array.isArray(pulls) ? pulls : []) {
      for (const key of prKeys(pr, opts.projectKey, keyByIssue)) {
        if (!itemByKey.has(key)) continue;
        pullsByKey.set(key, [...(pullsByKey.get(key) ?? []), pr]);
      }
    }
    for (const [key, prs] of pullsByKey) {
      const item = itemByKey.get(key)!;
      const kComments: { body: string }[] = await client.query(api.comments.listForItem, { workItemId: item._id });
      const seen = new Set(kComments.flatMap((c) => [...c.body.matchAll(PR_MARKER_RE)].map((m) => `${m[1]}:${m[2]}`)));
      for (const pr of prs) {
        const state = prState(pr);
        const event = state === "merged" ? "merged" : state === "open" ? "open" : undefined;
        if (!event || seen.has(`${pr.number}:${event}`)) continue;
        opts.log(`pr ${key} ← #${pr.number} ${event}`);
        report.prLinks.push(`${key} ← #${pr.number} ${event}`);
        if (opts.dryRun) continue;
        await client.mutation(api.comments.add, { workItemId: item._id, author: opts.actor, body: `PR #${pr.number} ${event === "merged" ? "merged" : "opened"}: ${pr.title} ${pr.html_url} (gh-pr:${pr.number}:${event})` });
        if (["backlog", "todo", "in_progress"].includes(item.status)) {
          await client.mutation(api.workItems.move, { id: item._id, actor: opts.actor, status: "in_review" });
          item.status = "in_review";
          report.movedToReview.push(key);
        }
      }
    }
  }

  // Labels and milestones Kanban needs.
  const scope = items.filter((x) => x.status !== "done" || opts.includeDone || issueByKey.has(x.key));
  const wantLabels = new Set(scope.flatMap(labelsFor));
  const haveLabels = new Set((await paginate(gh, `repos/${R}/labels?per_page=100`)).map((l: { name: string }) => l.name));
  for (const name of wantLabels) {
    if (haveLabels.has(name)) continue;
    opts.log(`label ${name}`);
    if (!opts.dryRun) await apiCall(gh, "POST", `repos/${R}/labels`, { name, color: labelColor(name) }).catch(() => undefined);
  }
  const milestones: { number: number; title: string }[] = await paginate(gh, `repos/${R}/milestones?state=all&per_page=100`);
  const milestoneBySprint = new Map<string, number>();
  for (const s of sprints) {
    let m = milestones.find((x) => x.title === s.name);
    if (!m && scope.some((x) => x.sprintId === s._id)) {
      opts.log(`milestone ${s.name}`);
      if (!opts.dryRun) m = await apiCall(gh, "POST", `repos/${R}/milestones`, { title: s.name, description: s.goal ?? "", ...(s.endDate ? { due_on: `${s.endDate}T23:59:59Z` } : {}) });
    }
    if (m) milestoneBySprint.set(s._id, m.number);
  }

  const keyById = new Map(items.map((x) => [x._id, x]));
  const childrenOf = (id: string) => items.filter((x) => x.parentId === id).sort((a, b) => a.number - b.number);
  const depth = (x: SyncItem): number => (x.parentId && keyById.has(x.parentId) ? 1 + depth(keyById.get(x.parentId)!) : 0);
  const ordered = [...scope].sort((a, b) => depth(a) - depth(b) || a.number - b.number);
  const sprintName = (x: SyncItem) => sprints.find((s) => s._id === x.sprintId)?.name;
  const ctxFor = (x: SyncItem): BodyContext => ({ boardUrl: opts.boardUrl, keyById, issueByKey, children: childrenOf(x._id), sprintName: sprintName(x), pulls: (pullsByKey.get(x.key) ?? []).sort((a, b) => a.number - b.number) });

  // Kanban → GitHub: create missing issues (parents first so bodies can link them).
  const fresh = new Set<string>();
  for (const x of ordered) {
    if (issueByKey.has(x.key) || x.status === "done") continue;
    opts.log(`create ${x.key} ${x.title}`);
    if (opts.dryRun) continue;
    const issue: Issue = await apiCall(gh, "POST", `repos/${R}/issues`, {
      title: `[${x.key}] ${x.title}`,
      body: renderBody(x, ctxFor(x)),
      labels: labelsFor(x),
      ...(x.sprintId && milestoneBySprint.has(x.sprintId) ? { milestone: milestoneBySprint.get(x.sprintId) } : {}),
    });
    issueByKey.set(x.key, issue);
    fresh.add(x.key);
    report.created.push(`${x.key} → #${issue.number}`);
  }

  // Kanban → GitHub: push fields; Kanban overwrites GitHub edits.
  for (const x of ordered) {
    const issue = issueByKey.get(x.key);
    if (!issue) continue;
    const want = {
      title: `[${x.key}] ${x.title}`,
      body: renderBody(x, ctxFor(x)),
      labels: [...new Set([...labelsFor(x), ...issue.labels.map((l) => l.name).filter((n) => !/^(kanban|type: |priority: |status: |area: )/.test(n))])].sort(),
      milestone: x.sprintId ? milestoneBySprint.get(x.sprintId) ?? null : null,
      state: desiredState(x.status, issue.state),
    };
    const have = { title: issue.title, body: issue.body ?? "", labels: issue.labels.map((l) => l.name).sort(), milestone: issue.milestone?.number ?? null, state: issue.state };
    const patch: Record<string, unknown> = {};
    if (want.title !== have.title) patch.title = want.title;
    if (want.body !== have.body) patch.body = want.body;
    if (want.labels.join("\n") !== have.labels.join("\n")) patch.labels = want.labels;
    if (want.milestone !== have.milestone) patch.milestone = want.milestone;
    if (want.state !== have.state) {
      patch.state = want.state;
      if (want.state === "closed") patch.state_reason = "completed";
    }
    if (Object.keys(patch).length === 0) continue;
    if (!fresh.has(x.key) || Object.keys(patch).some((k) => k !== "body")) opts.log(`update ${x.key} #${issue.number} (${Object.keys(patch).join(", ")})`);
    if (opts.dryRun) continue;
    await apiCall(gh, "PATCH", `repos/${R}/issues/${issue.number}`, patch);
    if (patch.state === "closed") report.closed.push(x.key);
    else if (patch.state === "open") report.reopened.push(x.key);
    else if (!fresh.has(x.key)) report.updated.push(x.key);
  }

  // Hierarchy and dependencies as native GitHub sub-issues and blocked-by links (best effort).
  if (!opts.dryRun) {
    for (const x of ordered) {
      if (!fresh.has(x.key) && !opts.relink) continue;
      const issue = issueByKey.get(x.key)!;
      const parent = x.parentId ? keyById.get(x.parentId) : undefined;
      const parentIssue = parent ? issueByKey.get(parent.key) : undefined;
      if (parentIssue) {
        await apiCall(gh, "POST", `repos/${R}/issues/${parentIssue.number}/sub_issues`, { sub_issue_id: issue.id }).then(() => report.linked++, () => undefined);
      }
      for (const depId of x.dependsOn ?? []) {
        const dep = keyById.get(depId);
        const depIssue = dep ? issueByKey.get(dep.key) : undefined;
        if (depIssue) await apiCall(gh, "POST", `repos/${R}/issues/${issue.number}/dependencies/blocked_by`, { issue_id: depIssue.id }).then(() => report.linked++, () => undefined);
      }
    }
  }

  // Comments both ways. GitHub comments land on the card once; Kanban comments land on the issue once.
  if (opts.comments) {
    for (const x of ordered) {
      const issue = issueByKey.get(x.key);
      if (!issue || fresh.has(x.key)) continue;
      const kComments: { _id: string; author: string; body: string }[] = await client.query(api.comments.listForItem, { workItemId: x._id });
      const ghComments: { id: number; body: string; user?: { login: string }; html_url: string }[] = issue.comments > 0 || kComments.length > 0 ? await paginate(gh, `repos/${R}/issues/${issue.number}/comments?per_page=100`) : [];
      const mirroredFromGh = new Set(kComments.map((c) => GH_COMMENT_RE.exec(c.body)?.[1]).filter(Boolean));
      const mirroredFromKanban = new Set(ghComments.map((c) => KANBAN_COMMENT_RE.exec(c.body)?.[1]).filter(Boolean));
      for (const c of ghComments) {
        if (KANBAN_COMMENT_RE.test(c.body) || c.body.includes(SYNC_NOTE) || mirroredFromGh.has(String(c.id))) continue;
        opts.log(`comment ${x.key} ← GitHub #${issue.number}`);
        if (opts.dryRun) continue;
        await client.mutation(api.comments.add, { workItemId: x._id, author: opts.actor, body: `[GitHub @${c.user?.login ?? "unknown"}] ${c.body}\n\n${c.html_url} (gh-comment:${c.id})` });
        report.commentsToKanban++;
      }
      for (const c of kComments) {
        if (GH_COMMENT_RE.test(c.body) || mirroredFromKanban.has(String(c._id))) continue;
        opts.log(`comment ${x.key} → GitHub #${issue.number}`);
        if (opts.dryRun) continue;
        await apiCall(gh, "POST", `repos/${R}/issues/${issue.number}/comments`, { body: `**${c.author}** (Kanban):\n\n${c.body}\n\n<!-- kanban-comment:${c._id} -->` });
        report.commentsToGithub++;
      }
    }
  }
  return report;
}

export function formatReport(r: SyncReport, dryRun: boolean): string {
  const line = (label: string, xs: string[]) => (xs.length ? `${label} (${xs.length}): ${xs.join(", ")}` : "");
  return [
    dryRun ? "Dry run — nothing was changed." : "",
    line("Created", r.created),
    line("Updated", r.updated),
    line("Closed", r.closed),
    line("Reopened", r.reopened),
    line("Imported from GitHub", r.importedFromGithub),
    line("Moved to in_review (closed on GitHub)", r.movedToReview),
    r.commentsToKanban || r.commentsToGithub ? `Comments: ${r.commentsToKanban} to Kanban, ${r.commentsToGithub} to GitHub` : "",
    r.linked ? `Sub-issue/dependency links: ${r.linked}` : "",
    line("Pull requests", r.prLinks),
  ].filter(Boolean).join("\n") || "Already in sync.";
}

/** The issue that mirrors a card, if any. */
export async function findIssue(repo: string, key: string, gh: Gh = ghCli): Promise<Issue | undefined> {
  const issues: Issue[] = (await paginate(gh, `repos/${repo}/issues?state=all&per_page=100`)).filter((i: Issue) => !i.pull_request);
  return issues.find((i) => issueKey(i) === key);
}

/** Title and body for a pull request that delivers a card. */
export function prDraft(item: Pick<SyncItem, "key" | "title" | "description">, issue: Pick<Issue, "number"> | undefined, extra?: string): { title: string; body: string } {
  const { criteria } = splitAcceptance(item.description);
  const lines = [issue ? `Closes #${issue.number} (${item.key}).` : `${item.key}.`, ""];
  if (extra) lines.push(extra.trim(), "");
  if (criteria.length) lines.push("## Acceptance criteria", "", ...criteria.map((c) => `- [ ] ${c}`), "");
  lines.push("## Test plan", "", "- [ ] ", "");
  return { title: `${item.key}: ${item.title}`, body: lines.join("\n") };
}

export { paginate as ghPaginate };
