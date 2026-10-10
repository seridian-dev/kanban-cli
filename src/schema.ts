/**
 * Machine-readable description of every kanban command. Consumed by `kanban schema`
 * and checked by schema.test.ts against FULL_HELP and BOOLEAN_FLAGS so it cannot drift.
 */
import { readFileSync } from "node:fs";

export type FlagType = "string" | "boolean" | "number" | "list";

export interface ArgSpec {
  name: string;
  required: boolean;
  description: string;
  values?: readonly string[];
}

export interface FlagSpec {
  name: string;
  type: FlagType;
  required: boolean;
  description: string;
  values?: readonly string[];
}

export interface CommandSpec {
  /** Space-separated words after `kanban`, e.g. "items create". */
  command: string;
  summary: string;
  args: ArgSpec[];
  flags: FlagSpec[];
  /** Whether --json changes the output (login and agent-help print text only). */
  json: boolean;
  /** Deletes or irreversibly invalidates data. */
  destructive: boolean;
}

const STATUS = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
const PRIORITY = ["urgent", "high", "medium", "low", "none"] as const;
const TYPE = ["epic", "story", "task", "bug", "subtask"] as const;

const str = (name: string, description: string, required = false, values?: readonly string[]): FlagSpec => ({ name, type: "string", required, description, ...(values ? { values } : {}) });
const bool = (name: string, description: string, required = false): FlagSpec => ({ name, type: "boolean", required, description });
const num = (name: string, description: string, required = false): FlagSpec => ({ name, type: "number", required, description });
const list = (name: string, description: string, required = false): FlagSpec => ({ name, type: "list", required, description });
const projectFlag = str("project", "Project key such as WEB. Defaults to KANBAN_PROJECT, the linked folder, or the saved default.");
const keyArg: ArgSpec = { name: "key", required: true, description: "Item key such as WEB-12." };

const HELP_FLAG = bool("help", "Print the full human-readable help and exit.");
const JSON_FLAG = bool("json", "Print machine-readable JSON.");
const DRY_RUN_FLAG = bool("dry-run", "Print the planned changes without sending them.");

const SPECS: CommandSpec[] = [
  { command: "login", summary: "Sign in through the browser and approve this device.", args: [], flags: [], json: false, destructive: false },
  { command: "logout", summary: "Clear the saved CLI session on this device.", args: [], flags: [], json: false, destructive: false },
  { command: "auth whoami", summary: "Show the account linked to this device.", args: [], flags: [], json: true, destructive: false },
  { command: "projects list", summary: "List projects in the selected workspace.", args: [], flags: [], json: true, destructive: false },
  {
    command: "projects create", summary: "Create a project.", args: [],
    flags: [str("key", "Project key, uppercase letters and digits, e.g. WEB.", true), str("name", "Project name.", true), str("description", "Project description.")],
    json: true, destructive: false,
  },
  {
    command: "projects update", summary: "Rename a project and/or change its description. The key never changes; owners and admins only.",
    args: [{ name: "key", required: true, description: "Project key such as WEB." }],
    flags: [
      str("name", "New project name."),
      str("description", "New description. Pass an empty string to clear it."),
      str("workspace", "Workspace slug. Needed only when more than one workspace has this key."),
    ],
    json: true, destructive: false,
  },
  {
    command: "projects move", summary: "File a project in a folder, or at the top level with --folder none.",
    args: [{ name: "key", required: true, description: "Project key such as WEB." }],
    flags: [str("folder", "Folder name or id, or none for the top level.", true)],
    json: true, destructive: false,
  },
  {
    command: "folders list", summary: "Show the workspace's folders as a tree, with their projects.", args: [],
    flags: [str("workspace", "Workspace slug. Defaults to the selected workspace.")], json: true, destructive: false,
  },
  {
    command: "folders create", summary: "Create a folder. Folders nest one level deep.",
    args: [{ name: "name", required: true, description: "Folder name." }],
    flags: [str("parent", "Parent folder name or id. Omit for a top-level folder."), str("workspace", "Workspace slug. Defaults to the selected workspace.")],
    json: true, destructive: false,
  },
  {
    command: "folders rename", summary: "Rename a folder.",
    args: [{ name: "folder", required: true, description: "Folder name or id." }],
    flags: [str("name", "New folder name.", true), str("workspace", "Workspace slug. Defaults to the selected workspace.")],
    json: true, destructive: false,
  },
  {
    command: "folders delete", summary: "Delete a folder. Its projects and subfolders move to the top level; nothing else is deleted.",
    args: [{ name: "folder", required: true, description: "Folder name or id." }],
    flags: [bool("yes", "Required confirmation. Without it nothing is deleted.", true), str("workspace", "Workspace slug. Defaults to the selected workspace.")],
    json: true, destructive: true,
  },
  { command: "projects open", summary: "Open a project board in the browser.", args: [{ name: "key", required: false, description: "Project key. Defaults to the selected project." }], flags: [], json: true, destructive: false },
  {
    command: "link", summary: "Link this Git repo or a folder to a workspace project.", args: [],
    flags: [str("project", "Project key to link.", true), str("path", "Folder to link. Defaults to the Git root."), str("workspace", "Workspace slug."), str("board-url", "Board URL written into GitHub issue bodies.")],
    json: true, destructive: false,
  },
  { command: "context", summary: "Show which workspace and project this folder uses.", args: [], flags: [str("workspace", "Workspace slug override."), projectFlag], json: true, destructive: false },
  { command: "defaults", summary: "Show effective workspace and project defaults and their source.", args: [], flags: [str("workspace", "Workspace slug override."), projectFlag], json: true, destructive: false },
  { command: "update check", summary: "Check npm for a newer CLI version now.", args: [], flags: [], json: true, destructive: false },
  { command: "links list", summary: "List saved folder-to-project links.", args: [], flags: [], json: true, destructive: false },
  { command: "links remove", summary: "Remove the saved link for a folder.", args: [], flags: [str("path", "Folder whose link to remove. Defaults to the Git root.")], json: true, destructive: false },
  { command: "config", summary: "Show saved site, user, workspace, and project settings.", args: [], flags: [], json: true, destructive: false },
  {
    command: "config set", summary: "Save a local CLI setting.",
    args: [
      { name: "key", required: true, description: "Setting to change.", values: ["site", "user", "workspace", "project"] },
      { name: "value", required: true, description: "New value." },
    ],
    flags: [], json: true, destructive: false,
  },
  { command: "hooks install", summary: "Install the local pre-commit and pre-push Kanban checks.", args: [], flags: [], json: true, destructive: false },
  { command: "hooks set-item", summary: "Set the active item for this Git repository.", args: [keyArg], flags: [], json: true, destructive: false },
  { command: "hooks doctor", summary: "Show hook installation and the active item.", args: [], flags: [], json: true, destructive: false },
  {
    command: "hooks check", summary: "Run a hook stage check (called by installed hooks).", args: [],
    flags: [str("stage", "Hook stage to check.", true, ["pre-commit", "pre-push"]), projectFlag], json: true, destructive: false,
  },
  {
    command: "next", summary: "Next card to work on: ready, highest priority, active sprint first.", args: [],
    flags: [projectFlag, str("assignee", "Assignee handle. Defaults to the signed-in user.")], json: true, destructive: false,
  },
  { command: "plan", summary: "Active sprint at a glance: ready, blocked, in progress, review, done, points.", args: [], flags: [projectFlag], json: true, destructive: false },
  { command: "agent-help", summary: "Print the short coding-agent workflow.", args: [], flags: [], json: false, destructive: false },
  { command: "help", summary: "Print the full human-readable command reference.", args: [], flags: [], json: false, destructive: false },
  {
    command: "schema", summary: "Print this machine-readable command schema as JSON.",
    args: [{ name: "command", required: false, description: "Optional command words, e.g. items create. Prints only that command." }],
    flags: [], json: true, destructive: false,
  },
  {
    command: "changelog", summary: "Markdown of done work for a project, grouped by day and epic.",
    args: [{ name: "project", required: false, description: "Project key. Defaults to the selected project." }],
    flags: [str("write", "Write the changelog to this file, keeping hand-written content."), projectFlag], json: true, destructive: false,
  },
  { command: "tree", summary: "Indented hierarchy of a project.", args: [{ name: "project", required: false, description: "Project key. Defaults to the selected project." }], flags: [], json: true, destructive: false },
  {
    command: "items list", summary: "List items with optional filters.", args: [],
    flags: [
      projectFlag,
      str("status", "Filter by status.", false, STATUS),
      str("assignee", "Filter by assignee."),
      str("type", "Filter by item type.", false, TYPE),
      str("epic", "Filter to the subtree of this epic key, e.g. WEB-1."),
      str("q", "Free-text search."),
      num("limit", "Maximum rows, 1 to 100."),
      bool("compact", "Return only key, type, status, title, and non-empty metadata."),
    ],
    json: true, destructive: false,
  },
  { command: "items get", summary: "Show an item with breadcrumb, children, dependencies, and comments.", args: [keyArg], flags: [], json: true, destructive: false },
  {
    command: "items create", summary: "Create an item.", args: [],
    flags: [
      projectFlag,
      str("type", "Item type.", true, TYPE),
      str("title", "Item title.", true),
      str("parent", "Parent item key, e.g. WEB-1."),
      str("status", "Initial status.", false, STATUS),
      str("priority", "Priority.", false, PRIORITY),
      str("assignee", "Assignee handle."),
      num("points", "Story points."),
      str("start", "Start date, YYYY-MM-DD."),
      str("due", "Due date, YYYY-MM-DD."),
      list("labels", "Comma-separated labels."),
      str("sprint", "Sprint name or id."),
      str("description", "Item description."),
    ],
    json: true, destructive: false,
  },
  {
    command: "items update", summary: "Change fields on an item. Pass \"none\" to clear assignee, points, start, due, parent, depends-on, or sprint.",
    args: [keyArg],
    flags: [
      str("title", "New title."),
      str("description", "New description."),
      str("type", "New type.", false, TYPE),
      str("status", "New status.", false, STATUS),
      str("priority", "New priority.", false, PRIORITY),
      str("assignee", "Assignee handle, or none."),
      str("start", "Start date YYYY-MM-DD, or none."),
      str("due", "Due date YYYY-MM-DD, or none."),
      list("labels", "Comma-separated labels (replaces the set)."),
      num("points", "Story points, or none."),
      str("parent", "Parent item key, or none."),
      list("depends-on", "Comma-separated item keys this item depends on, or none."),
      str("sprint", "Sprint name or id, or none."),
    ],
    json: true, destructive: false,
  },
  {
    command: "items move", summary: "Change an item's status and optionally its position.", args: [keyArg],
    flags: [str("status", "Target status.", true, STATUS), str("after", "Place after this item key."), str("before", "Place before this item key.")],
    json: true, destructive: false,
  },
  {
    command: "items rm", summary: "Delete an item and its whole subtree.", args: [keyArg],
    flags: [bool("yes", "Required confirmation. Without it nothing is deleted.", true)],
    json: true, destructive: true,
  },
  {
    command: "items breakdown", summary: "Create child items from lines of text (epic to stories, others to subtasks).", args: [keyArg],
    flags: [str("text", "One child item per line. Omit to read lines from stdin.")], json: true, destructive: false,
  },
  { command: "items distribute", summary: "Assign unassigned children to people by open load.", args: [keyArg], flags: [list("people", "Comma-separated people to balance across.", true)], json: true, destructive: false },
  {
    command: "items bulk", summary: "Update several items at once.", args: [],
    flags: [
      list("ids", "Comma-separated item keys.", true),
      str("status", "New status.", false, STATUS),
      str("priority", "New priority.", false, PRIORITY),
      str("assignee", "Assignee handle, or none."),
      str("sprint", "Sprint name or id, or none."),
    ],
    json: true, destructive: false,
  },
  { command: "comment add", summary: "Add a comment to an item.", args: [keyArg], flags: [str("body", "Comment text. Omit to read from stdin.")], json: true, destructive: false },
  { command: "comment list", summary: "List comments on an item.", args: [keyArg], flags: [], json: true, destructive: false },
  { command: "sprints list", summary: "List sprints in a project.", args: [], flags: [projectFlag], json: true, destructive: false },
  {
    command: "sprints create", summary: "Create a sprint.", args: [],
    flags: [str("name", "Sprint name.", true), str("goal", "Sprint goal."), str("start", "Start date, YYYY-MM-DD."), str("end", "End date, YYYY-MM-DD."), projectFlag],
    json: true, destructive: false,
  },
  { command: "sprints start", summary: "Start a sprint.", args: [{ name: "sprint", required: true, description: "Sprint name or id." }], flags: [projectFlag], json: true, destructive: false },
  { command: "sprints complete", summary: "Complete a sprint.", args: [{ name: "sprint", required: true, description: "Sprint name or id." }], flags: [projectFlag], json: true, destructive: false },
  {
    command: "git connect", summary: "Connect a project to a GitHub or GitLab repository and return a webhook secret.", args: [],
    flags: [projectFlag, str("provider", "Git host.", true, ["github", "gitlab"]), str("repo", "Repository as owner/name.", true), str("host", "Host name for self-hosted GitLab.")],
    json: true, destructive: false,
  },
  { command: "git status", summary: "List git connections for a project.", args: [], flags: [projectFlag], json: true, destructive: false },
  { command: "git links", summary: "List git links (PRs, branches) for an item.", args: [keyArg], flags: [], json: true, destructive: false },
  { command: "git prs", summary: "List open pull or merge requests grouped by card.", args: [], flags: [projectFlag], json: true, destructive: false },
  { command: "git branch", summary: "Print the suggested git branch name for an item.", args: [keyArg], flags: [], json: true, destructive: false },
  {
    command: "git rotate-secret", summary: "Rotate a connection's webhook secret. The old secret stops working.", args: [],
    flags: [projectFlag, str("connection", "Connection id from git status.", true)], json: true, destructive: true,
  },
  {
    command: "gh sync", summary: "Two-way sync between a project and GitHub issues via the gh CLI. Kanban is the ground truth.", args: [],
    flags: [
      projectFlag,
      str("repo", "GitHub repository as owner/name. Defaults to the linked or origin repo."),
      bool("dry-run", "Print the plan without changing anything."),
      bool("include-done", "Also mirror done cards."),
      bool("no-comments", "Skip comment sync."),
      bool("relink", "Re-apply sub-issue and dependency links."),
      bool("no-prs", "Do not link pull requests or move cards to in_review."),
      str("board-url", "Board URL added to each issue."),
    ],
    json: true, destructive: false,
  },
  {
    command: "gh pr", summary: "Open a GitHub PR for the current branch and move the card to in_review.",
    args: [{ name: "key", required: false, description: "Item key. Defaults to the active item or the branch name." }],
    flags: [bool("draft", "Open as a draft. The card does not move to in_review."), str("base", "Base branch."), str("title", "PR title."), str("body", "PR body."), str("repo", "GitHub repository as owner/name.")],
    json: true, destructive: false,
  },
  { command: "gh issue", summary: "Print the GitHub issue URL for an item.", args: [{ name: "key", required: false, description: "Item key. Defaults to the active item or the branch name." }], flags: [str("repo", "GitHub repository as owner/name.")], json: true, destructive: false },
];

/** Commands that change data on the board, GitHub, or git. Each accepts --dry-run (gh sync declares its own). */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "projects create", "projects update", "projects move", "folders create", "folders rename", "folders delete", "items create", "items update", "items move", "items rm", "items breakdown", "items distribute", "items bulk",
  "comment add", "sprints create", "sprints start", "sprints complete", "git connect", "git rotate-secret", "gh pr",
]);

/** Flags every command accepts. Added to each entry so the schema lists them explicitly. */
function withCommonFlags(spec: CommandSpec): CommandSpec {
  const flags = [...spec.flags];
  if (spec.json && !flags.some((f) => f.name === "json")) flags.push(JSON_FLAG);
  if (WRITE_COMMANDS.has(spec.command) && !flags.some((f) => f.name === "dry-run")) flags.push(DRY_RUN_FLAG);
  if (!flags.some((f) => f.name === "help")) flags.push(HELP_FLAG);
  return { ...spec, flags };
}

export const COMMANDS: readonly CommandSpec[] = SPECS.map(withCommonFlags);

/** Schema-declared boolean flags; must equal BOOLEAN_FLAGS in lib.ts. */
export function booleanFlagNames(): string[] {
  const names = new Set<string>();
  for (const c of COMMANDS) for (const f of c.flags) if (f.type === "boolean") names.add(f.name);
  return [...names].sort();
}

export function schemaVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/** The whole schema document printed by `kanban schema`. */
export function schemaDocument() {
  return { version: schemaVersion(), commands: COMMANDS };
}

/** Find one command by its words, e.g. ["items", "create"]. */
export function findCommand(words: readonly string[]): CommandSpec | undefined {
  const wanted = words.join(" ");
  return COMMANDS.find((c) => c.command === wanted);
}
