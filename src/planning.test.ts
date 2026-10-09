import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNext, formatPlan, pickNext, planSprint, type PlanItem, type PlanSprint } from "./planning.js";

let seq = 0;
const card = (over: Partial<PlanItem> & { key: string }): PlanItem => {
  seq++;
  const number = Number(over.key.split("-")[1]);
  return { _id: `id-${over.key}`, title: `Card ${over.key}`, type: "task", status: "todo", priority: "medium", assignee: null, points: 1, dependsOn: [], sprintId: "s-active", number, rank: seq * 1000, ...over };
};
const active: PlanSprint = { _id: "s-active", name: "S1", state: "active", startDate: "2026-10-07", endDate: "2026-10-20" };
const planned: PlanSprint = { _id: "s-next", name: "S2", state: "planned", startDate: "2026-10-21", endDate: "2026-11-03" };
const sprints = [active, planned];

test("pickNext orders by priority, then sprint, then rank, then number", () => {
  const items = [
    card({ key: "PP-1", priority: "low" }),
    card({ key: "PP-2", priority: "high", rank: 5000 }),
    card({ key: "PP-3", priority: "high", rank: 100 }),
    card({ key: "PP-4", priority: "urgent", rank: 9999 }),
  ];
  assert.equal(pickNext(items, sprints, "cli").item?.key, "PP-4");
  assert.equal(pickNext(items.slice(0, 3), sprints, "cli").item?.key, "PP-3");
  const sameRank = [card({ key: "PP-9", priority: "medium", rank: 1 }), card({ key: "PP-7", priority: "medium", rank: 1 })];
  assert.equal(pickNext(sameRank, sprints, "cli").item?.key, "PP-7");
  const bySprint = [card({ key: "PP-5", sprintId: "s-next", rank: 1 }), card({ key: "PP-6", sprintId: "s-active", rank: 900 })];
  assert.equal(pickNext(bySprint, sprints, "cli").item?.key, "PP-6");
});

test("blocked cards are skipped and the reason names them", () => {
  const items = [
    card({ key: "PP-1", priority: "urgent", dependsOn: ["id-PP-2"] }),
    card({ key: "PP-2", priority: "none", status: "in_progress" }),
    card({ key: "PP-3", priority: "low" }),
  ];
  assert.equal(pickNext(items, sprints, "cli").item?.key, "PP-3");

  const onlyBlocked = [card({ key: "PP-1", dependsOn: ["id-PP-2"] }), card({ key: "PP-2", status: "in_progress" }), card({ key: "PP-4", dependsOn: ["id-PP-2"] })];
  const pick = pickNext(onlyBlocked, sprints, "cli");
  assert.equal(pick.item, undefined);
  assert.match(pick.reason, /2 todo cards are blocked by open dependencies/);
  assert.equal(pickNext([card({ key: "PP-1", dependsOn: ["id-PP-2"] }), card({ key: "PP-2", status: "done" })], sprints, "cli").item?.key, "PP-1");
});

test("unassigned and assigned-to-me cards are picked; others are not", () => {
  const items = [
    card({ key: "PP-1", priority: "urgent", assignee: "sam" }),
    card({ key: "PP-2", priority: "urgent", assignee: "alex" }),
    card({ key: "PP-3", priority: "medium", assignee: null }),
  ];
  assert.equal(pickNext(items, sprints, "alex").item?.key, "PP-2");
  assert.equal(pickNext(items, sprints, "nobody").item?.key, "PP-3");
  assert.equal(pickNext(items.slice(1), sprints, "alex").item?.key, "PP-2");
  const none = pickNext([card({ key: "PP-1", assignee: "sam" })], sprints, "alex");
  assert.equal(none.item, undefined);
  assert.match(none.reason, /1 todo card is assigned to someone else/);
});

test("backlog is only used when no todo card exists", () => {
  const withTodo = [card({ key: "PP-1", status: "backlog", priority: "urgent" }), card({ key: "PP-2", status: "todo", priority: "low" })];
  assert.equal(pickNext(withTodo, sprints, "cli").item?.key, "PP-2");
  const backlogOnly = [card({ key: "PP-1", status: "backlog", priority: "urgent" })];
  assert.equal(pickNext(backlogOnly, sprints, "cli").item?.key, "PP-1");
});

test("no active sprint falls back to any sprint, then the whole board", () => {
  const noActive = [planned];
  const items = [card({ key: "PP-1", sprintId: "s-next", priority: "high" }), card({ key: "PP-2", sprintId: null, priority: "urgent" })];
  const pick = pickNext(items, noActive, "cli");
  assert.equal(pick.item?.key, "PP-1");
  assert.match(pick.reason, /any sprint/);
  assert.equal(pickNext([card({ key: "PP-2", sprintId: null })], [], "cli").item?.key, "PP-2");
});

test("epics are never picked", () => {
  const items = [card({ key: "PP-1", type: "epic", priority: "urgent" }), card({ key: "PP-2", priority: "none" })];
  assert.equal(pickNext(items, sprints, "cli").item?.key, "PP-2");
  assert.match(pickNext([card({ key: "PP-1", type: "epic" })], sprints, "cli").reason, /No open cards in S1 \(active\)/);
});

test("formatNext prints key, why and the start command", () => {
  const pick = pickNext([card({ key: "PP-7", title: "Fix login", priority: "high" })], sprints, "cli");
  assert.equal(formatNext(pick), "PP-7  Fix login\nWhy: high priority; scope S1 (active); unassigned; no dependencies.\nStart: kanban items move PP-7 --status in_progress");
});

test("planSprint groups active sprint cards and sums points", () => {
  const items = [
    card({ key: "PP-1", status: "done", points: 3 }),
    card({ key: "PP-2", status: "in_progress", points: 5 }),
    card({ key: "PP-3", status: "in_review", points: 2 }),
    card({ key: "PP-4", status: "todo", points: 1 }),
    card({ key: "PP-5", status: "todo", points: 8, dependsOn: ["id-PP-2"] }),
    card({ key: "PP-6", status: "backlog", points: null }),
    card({ key: "PP-7", type: "epic", status: "todo", points: 13 }),
    card({ key: "PP-8", status: "done", points: 2, sprintId: "s-next" }),
  ];
  const report = planSprint(items, sprints);
  assert.equal(report.sprint?._id, "s-active");
  assert.deepEqual(report.ready, ["PP-4"]);
  assert.deepEqual(report.blocked, [{ key: "PP-5", blockedBy: ["PP-2"] }]);
  assert.equal(report.inProgress, 1);
  assert.equal(report.inReview, 1);
  assert.equal(report.done, 1);
  assert.equal(report.backlog, 1);
  assert.equal(report.total, 6);
  assert.deepEqual(report.points, { total: 19, done: 3 });
  assert.match(formatPlan(report, "PP"), /Ready 1 · Blocked 1 · In progress 1 · In review 1 · Done 1 · Backlog 1 · Total 6/);
});

test("planSprint shows the next planned sprint when none is active", () => {
  const items = [card({ key: "PP-1", sprintId: "s-next", status: "todo", points: 2 })];
  const report = planSprint(items, [planned, { ...active, _id: "s-old", state: "completed" }]);
  assert.equal(report.sprint?.name, "S2");
  assert.deepEqual(report.ready, ["PP-1"]);
  assert.equal(formatPlan(planSprint([], []), "PP"), "No active or planned sprint in PP. Create one with kanban sprints create --project PP --name NAME.");
});
