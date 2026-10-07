import { test } from "node:test";
import assert from "node:assert/strict";
import { desiredState, closedOnGithub, issueKey, labelsFor, markerFor, renderBody, splitAcceptance, syncGithub, type Gh, type Issue, type SyncItem } from "./gh-sync.js";

const item = (over: Partial<SyncItem> = {}): SyncItem => ({ _id: "i1", key: "PP-5", type: "story", status: "todo", title: "Do it", number: 5, priority: "high", labels: ["ux"], ...over });

test("issueKey reads the body marker, then a [KEY] title prefix", () => {
  assert.equal(issueKey({ body: `x\n${markerFor("PP-9")}`, title: "anything" }), "PP-9");
  assert.equal(issueKey({ body: "no marker", title: "[PP-12] Old mirror" }), "PP-12");
  assert.equal(issueKey({ body: null, title: "Plain issue" }), undefined);
});

test("splitAcceptance turns AC into checkboxes", () => {
  assert.deepEqual(splitAcceptance("Context here. AC: one; two."), { context: "Context here.", criteria: ["one", "two"] });
  assert.deepEqual(splitAcceptance("Just context"), { context: "Just context", criteria: [] });
});

test("labelsFor maps type, priority, status and areas", () => {
  assert.deepEqual(labelsFor(item({ status: "in_progress" })), ["kanban", "type: story", "priority: high", "status: in progress", "area: ux"]);
});

test("Kanban state wins, but in_review never reopens a closed issue", () => {
  assert.equal(desiredState("done", "open"), "closed");
  assert.equal(desiredState("todo", "closed"), "open");
  assert.equal(desiredState("in_review", "closed"), "closed");
  assert.equal(desiredState("in_review", "open"), "open");
  assert.equal(closedOnGithub(item(), { state: "closed" } as Issue), true);
  assert.equal(closedOnGithub(item({ status: "done" }), { state: "closed" } as Issue), false);
});

test("renderBody ends with the marker and links known issues", () => {
  const parent = item({ _id: "p", key: "PP-1", type: "epic", title: "Epic" });
  const body = renderBody(item({ parentId: "p" }), { keyById: new Map([["p", parent]]), issueByKey: new Map([["PP-1", { number: 7 } as Issue]]), children: [] });
  assert.match(body, /\*\*Parent:\*\* #7 \(PP-1\) Epic/);
  assert.ok(body.endsWith(markerFor("PP-5")));
});

function fakes(issues: Issue[], items: SyncItem[]) {
  const calls: string[] = [];
  let next = 100;
  const gh: Gh = async (args, input: any) => {
    const [, ...rest] = args;
    const method = rest[0] === "-X" ? rest[1] : "GET";
    const path = rest.find((a) => a.startsWith("repos/"))!;
    calls.push(`${method} ${path}`);
    if (path === "repos/me/fork") return { has_issues: true };
    if (path.startsWith("repos/me/fork/issues?")) return [issues];
    if (path.includes("/labels?") || path.includes("/milestones?")) return [[]];
    if (method === "POST" && path === "repos/me/fork/issues") { const n = next++; return { number: n, id: n * 10, title: input.title, body: input.body, state: "open", labels: [], milestone: null, comments: 0, html_url: "" }; }
    if (path.includes("/comments")) return [[]];
    return {};
  };
  const mutations: string[] = [];
  const client = {
    async query(_ref: unknown, args: any) {
      if (args && "key" in args) return { _id: "proj" };
      if (args && "projectId" in args) return items;
      if (args && "workItemId" in args) return [];
      return [];
    },
    async mutation(_ref: unknown, args: any) { mutations.push(JSON.stringify(args)); if (args.type) { items.push(item({ _id: "new", key: "PP-99", title: args.title, status: "backlog", number: 99 })); return "new"; } return null; },
  };
  return { gh, client, calls, mutations };
}

const opts = { projectKey: "PP", repo: "me/fork", actor: "cli", dryRun: false, includeDone: false, comments: true, relink: false, log: () => {} };

test("sync creates issues for open cards, skips done, and only talks to the given repo", async () => {
  const { gh, client, calls } = fakes([], [item(), item({ _id: "d", key: "PP-6", number: 6, status: "done" })]);
  const r = await syncGithub(client, opts, gh);
  assert.deepEqual(r.created, ["PP-5 → #100"]);
  assert.ok(calls.every((c) => c.includes("repos/me/fork")));
});

test("sync imports unmarked GitHub issues and moves cards closed on GitHub to review", async () => {
  const closed: Issue = { number: 3, id: 30, title: "[PP-5] Do it", body: markerFor("PP-5"), state: "closed", labels: [], milestone: null, comments: 0, html_url: "u" };
  const stray: Issue = { number: 4, id: 40, title: "Leak in 2B", body: "help", state: "open", labels: [{ name: "bug" }], milestone: null, comments: 0, html_url: "u4", user: { login: "dev" } };
  const { gh, client, mutations } = fakes([closed, stray], [item()]);
  const r = await syncGithub(client, opts, gh);
  assert.deepEqual(r.importedFromGithub, ["PP-99 ← #4"]);
  assert.deepEqual(r.movedToReview, ["PP-5"]);
  assert.ok(mutations.some((m) => m.includes('"type":"bug"')));
  assert.equal(r.reopened.length, 0, "in_review keeps the GitHub issue closed");
});

test("dry run changes nothing", async () => {
  const { gh, client, calls, mutations } = fakes([], [item()]);
  await syncGithub(client, { ...opts, dryRun: true }, gh);
  assert.ok(calls.every((c) => c.startsWith("GET")));
  assert.equal(mutations.length, 0);
});
