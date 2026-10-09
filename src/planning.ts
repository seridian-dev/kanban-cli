/** Pure planning helpers for `kanban next` and `kanban plan`. No I/O: callers pass board rows in. */

export interface PlanItem {
  _id: string;
  key: string;
  title: string;
  type: string;
  status: string;
  priority?: string | null;
  assignee?: string | null;
  points?: number | null;
  dependsOn?: string[] | null;
  sprintId?: string | null;
  number: number;
  rank?: number | null;
}

export interface PlanSprint {
  _id: string;
  name: string;
  state: string;
  startDate?: string | null;
  endDate?: string | null;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const SPRINT_STATE_RANK: Record<string, number> = { active: 0, planned: 1 };

const priorityRank = (item: PlanItem) => PRIORITY_RANK[item.priority ?? "none"] ?? PRIORITY_RANK.none;
const rankOf = (item: PlanItem) => item.rank ?? Number.MAX_SAFE_INTEGER;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Keys of dependencies that are not done yet. Dependencies missing from the board count as open. */
export function openDependencies(item: PlanItem, byId: ReadonlyMap<string, PlanItem>): string[] {
  return (item.dependsOn ?? []).flatMap((id) => {
    const dep = byId.get(id);
    if (!dep) return [id];
    return dep.status === "done" ? [] : [dep.key];
  });
}

export interface Scope {
  label: string;
  sprint?: PlanSprint;
  items: PlanItem[];
}

/** Active sprint if there is one, else items in any sprint, else the whole board. */
export function nextScope(items: readonly PlanItem[], sprints: readonly PlanSprint[]): Scope {
  const active = sprints.find((s) => s.state === "active");
  if (active) return { label: `${active.name} (active)`, sprint: active, items: items.filter((i) => i.sprintId === active._id) };
  const known = new Set(sprints.map((s) => s._id));
  const inAnySprint = items.filter((i) => i.sprintId && known.has(i.sprintId));
  if (inAnySprint.length) return { label: "any sprint (no active sprint)", items: inAnySprint };
  return { label: "the board (no sprints)", items: [...items] };
}

export interface NextPick {
  item?: PlanItem;
  scope: string;
  readyCount: number;
  reason: string;
}

/** The single card to work on next. Ready means todo (or backlog when no todo exists), not an epic, deps done, and unassigned or assigned to `assignee`. */
export function pickNext(items: readonly PlanItem[], sprints: readonly PlanSprint[], assignee: string): NextPick {
  const byId = new Map(items.map((i) => [i._id, i]));
  const stateById = new Map(sprints.map((s) => [s._id, s.state]));
  const scope = nextScope(items, sprints);
  const cards = scope.items.filter((i) => i.type !== "epic");
  const status = cards.some((i) => i.status === "todo") ? "todo" : "backlog";
  const pool = cards.filter((i) => i.status === status);
  const mine = pool.filter((i) => !i.assignee || i.assignee === assignee);
  const sprintRank = (i: PlanItem) => (i.sprintId ? (SPRINT_STATE_RANK[stateById.get(i.sprintId) ?? ""] ?? 2) : 3);
  const ready = mine
    .filter((i) => openDependencies(i, byId).length === 0)
    .sort((a, b) => priorityRank(a) - priorityRank(b) || sprintRank(a) - sprintRank(b) || rankOf(a) - rankOf(b) || a.number - b.number);

  if (ready.length) {
    const item = ready[0];
    const assigneeText = item.assignee ? `assigned to ${item.assignee}` : "unassigned";
    const depsText = (item.dependsOn ?? []).length ? "all dependencies done" : "no dependencies";
    return {
      item,
      scope: scope.label,
      readyCount: ready.length,
      reason: `${item.priority ?? "none"} priority; scope ${scope.label}; ${assigneeText}; ${depsText}.`,
    };
  }

  if (!pool.length) {
    return { scope: scope.label, readyCount: 0, reason: cards.length ? `No todo or backlog cards in ${scope.label}.` : `No open cards in ${scope.label}.` };
  }
  const blocked = mine.filter((i) => openDependencies(i, byId).length > 0).length;
  const others = pool.length - mine.length;
  const parts: string[] = [];
  if (blocked) parts.push(`${plural(blocked, `${status} card`)} ${blocked === 1 ? "is" : "are"} blocked by open dependencies`);
  if (others) parts.push(`${plural(others, `${status} card`)} ${others === 1 ? "is" : "are"} assigned to someone else (use --assignee NAME)`);
  return { scope: scope.label, readyCount: 0, reason: `No ready card in ${scope.label}: ${parts.join("; ") || "nothing matches"}.` };
}

export function formatNext(pick: NextPick): string {
  if (!pick.item) return pick.reason;
  const item = pick.item;
  return [
    `${item.key}  ${item.title}`,
    `Why: ${pick.reason}${pick.readyCount > 1 ? ` ${plural(pick.readyCount - 1, "other ready card")} follow.` : ""}`,
    `Start: kanban items move ${item.key} --status in_progress`,
  ].join("\n");
}

export interface PlanReport {
  sprint: PlanSprint | null;
  total: number;
  ready: string[];
  blocked: { key: string; blockedBy: string[] }[];
  inProgress: number;
  inReview: number;
  done: number;
  backlog: number;
  points: { total: number; done: number };
}

/** Active sprint, else the earliest planned sprint. Epics are not counted. */
export function planSprint(items: readonly PlanItem[], sprints: readonly PlanSprint[]): PlanReport {
  const planned = sprints
    .filter((s) => s.state === "planned")
    .sort((a, b) => (a.startDate ?? "￿").localeCompare(b.startDate ?? "￿") || a.name.localeCompare(b.name));
  const sprint = sprints.find((s) => s.state === "active") ?? planned[0] ?? null;
  const report: PlanReport = { sprint, total: 0, ready: [], blocked: [], inProgress: 0, inReview: 0, done: 0, backlog: 0, points: { total: 0, done: 0 } };
  if (!sprint) return report;

  const byId = new Map(items.map((i) => [i._id, i]));
  const cards = items.filter((i) => i.sprintId === sprint._id && i.type !== "epic").sort((a, b) => priorityRank(a) - priorityRank(b) || rankOf(a) - rankOf(b) || a.number - b.number);
  report.total = cards.length;
  for (const card of cards) {
    const points = card.points ?? 0;
    report.points.total += points;
    switch (card.status) {
      case "done": report.done++; report.points.done += points; break;
      case "in_progress": report.inProgress++; break;
      case "in_review": report.inReview++; break;
      case "todo": {
        const blockedBy = openDependencies(card, byId);
        if (blockedBy.length) report.blocked.push({ key: card.key, blockedBy });
        else report.ready.push(card.key);
        break;
      }
      default: report.backlog++;
    }
  }
  return report;
}

export function formatPlan(report: PlanReport, projectKey: string): string {
  if (!report.sprint) return `No active or planned sprint in ${projectKey}. Create one with kanban sprints create --project ${projectKey} --name NAME.`;
  const s = report.sprint;
  const dates = s.startDate || s.endDate ? ` · ${s.startDate ?? "?"} → ${s.endDate ?? "?"}` : "";
  const lines = [
    `${projectKey}  ${s.name} (${s.state})${dates}`,
    `Ready ${report.ready.length} · Blocked ${report.blocked.length} · In progress ${report.inProgress} · In review ${report.inReview} · Done ${report.done} · Backlog ${report.backlog} · Total ${report.total}`,
    `Points ${report.points.done} of ${report.points.total} done`,
    `Ready: ${report.ready.join(", ") || "(none)"}`,
  ];
  if (report.blocked.length) {
    lines.push("Blocked:");
    for (const b of report.blocked) lines.push(`  ${b.key} waiting on ${b.blockedBy.join(", ")}`);
  }
  return lines.join("\n");
}
