/** Pure helpers for the kanban CLI: argument parsing, key parsing, formatting. */

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** Usage problems (exit code 2). */
export class UsageError extends Error {}

/** Flags that take no value. Every other flag requires one. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "yes", "help", "compact"]);

/**
 * Strict argument parser. A value flag must be given a value: `--k v`, `--k=v`
 * (value may start with `--`), or `--k -- <literal>` (next token taken verbatim).
 * A missing value, or one that looks like another flag, is a UsageError so a
 * command never silently does less than asked. A bare `--` elsewhere ends flag
 * parsing; the rest are positionals.
 */
export function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      const name = a.slice(2, eq);
      if (BOOLEAN_FLAGS.has(name)) throw new UsageError(`--${name} takes no value`);
      flags[name] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === "--" && i + 2 < argv.length) {
      flags[name] = argv[i + 2];
      i += 2;
    } else if (next !== undefined && next !== "--" && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      throw new UsageError(`--${name} needs a value (use --${name}=VALUE or "--${name} -- VALUE" if it starts with --)`);
    }
  }
  return { positionals, flags };
}

/** Choose a sprint by id, else by case-insensitive name, preferring non-completed on collisions. */
export function pickSprint<T extends { _id: string; name: string; state: string }>(
  sprints: readonly T[],
  ref: string,
): T | undefined {
  const byId = sprints.find((s) => s._id === ref);
  if (byId) return byId;
  const named = sprints.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  return named.find((s) => s.state !== "completed") ?? named[0];
}

/** Exit code for a server-side error message: 3 for "not found", else 1. */
export function classifyError(message: string): 1 | 3 {
  return /\bnot found\b/i.test(message) ? 3 : 1;
}

/** Read a stream to the end, failing clearly if it does not close within `timeoutMs`. */
export function readAll(stream: AsyncIterable<unknown> & { destroy?: () => unknown }, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new UsageError(`stdin did not close within ${timeoutMs}ms — pass the text with --text/--body instead`));
    }, timeoutMs);
    (async () => {
      try {
        for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array | string));
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    })();
  });
}

const KEY = /^([A-Za-z]{2,5})-(\d+)$/;

export function parseKey(s: string): { project: string; number: number; key: string } | null {
  const m = KEY.exec(s.trim());
  if (!m) return null;
  const project = m[1].toUpperCase();
  return { project, number: Number(m[2]), key: `${project}-${m[2]}` };
}

export const isItemKey = (s: string) => parseKey(s) !== null;

export function splitList(s: string | undefined): string[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

export interface TreeRow {
  key: string;
  type: string;
  title: string;
  status: string;
  assignee: string | null;
  depth: number;
}

export function formatTree(rows: readonly TreeRow[]): string {
  if (rows.length === 0) return "(no items)";
  return rows
    .map((r) => `${"  ".repeat(r.depth)}${r.key} [${r.type}] ${r.title} (${r.status})${r.assignee ? ` @${r.assignee}` : ""}`)
    .join("\n");
}

export function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  return all
    .map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] + 2))).join("").trimEnd())
    .join("\n");
}

/** A low-token projection for agent work discovery; omit empty metadata. */
export function compactItems<T extends {
  key: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  assignee?: string | null;
  dueDate?: string | null;
}>(rows: readonly T[]) {
  return rows.map((item) => ({
    key: item.key,
    type: item.type,
    status: item.status,
    ...(item.priority !== "none" ? { priority: item.priority } : {}),
    ...(item.assignee ? { assignee: item.assignee } : {}),
    ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    title: item.title,
  }));
}
