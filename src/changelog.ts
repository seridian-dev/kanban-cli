export interface ChangelogRow {
  key: string;
  title: string;
  type: "epic" | "story" | "task" | "bug" | "subtask";
  resolvedAt: number;
  epicKey: string | null;
  epicTitle: string | null;
  assignee: string | null;
}

const keyNumber = (k: string) => Number(k.split("-")[1]) || 0;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Render done work as a Keep-a-Changelog-ish markdown document: newest day
 * first, then epic, one line per story/task/bug. Subtasks roll up into their
 * parent; epics appear only as headings. Pure so it can be unit-tested.
 */
export function formatChangelog(projectKey: string, rows: readonly ChangelogRow[]): string {
  const entries = rows.filter((r) => r.type !== "subtask" && r.type !== "epic");
  const head = "# Changelog\n\n";
  if (entries.length === 0) return `${head}_Generated from the ${projectKey} board. Nothing has shipped yet._\n`;

  const days = new Map<string, Map<string, ChangelogRow[]>>();
  for (const r of entries) {
    const day = utcDay(r.resolvedAt);
    const epic = r.epicKey ? `${r.epicTitle} (${r.epicKey})` : "Other";
    const byEpic = days.get(day) ?? new Map<string, ChangelogRow[]>();
    byEpic.set(epic, [...(byEpic.get(epic) ?? []), r]);
    days.set(day, byEpic);
  }

  const out: string[] = [`${head}_Generated from the ${projectKey} board with \`kanban changelog ${projectKey}\`._\n`];
  for (const day of [...days.keys()].sort().reverse()) {
    out.push(`## ${day}\n`);
    const byEpic = days.get(day)!;
    const names = [...byEpic.keys()].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
    for (const name of names) {
      out.push(`### ${name}\n`);
      for (const r of byEpic.get(name)!.sort((a, b) => keyNumber(a.key) - keyNumber(b.key))) {
        out.push(`- ${r.key} ${r.title}${r.type === "bug" ? " (fix)" : ""}${r.assignee ? ` — ${r.assignee}` : ""}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

/** Keep repository-authored notes intact while replacing the generated tail. */
export function withGeneratedChangelog(existing: string, generated: string): string {
  const marker = "## Generated from the KAN board";
  const human = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)).trimEnd() : existing.trimEnd();
  const body = generated.replace(/^# Changelog\n+/, "").trim();
  return `${human}\n\n${marker}\n\n${body}\n`;
}
