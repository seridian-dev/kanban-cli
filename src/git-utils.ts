export type GitKind = "branch" | "commit" | "pr_opened" | "pr_ready" | "pr_merged" | "pr_closed" | "review_approved" | "review_changes_requested" | "ci_passed" | "ci_failed" | "issue_opened" | "issue_closed" | "note";
export type GitEvent = { provider: "github" | "gitlab"; repo: string; kind: GitKind; url: string; title: string; author: string; sha?: string; branch?: string; timestamp: number; keys: string[]; externalId?: string; draft?: boolean; closing?: boolean };
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function parseCardKeys(text: string, knownProjects: readonly string[]): string[] {
  const known = new Set(knownProjects.map((p) => p.toUpperCase())), found = new Set<string>();
  const re = /(?:^|[^A-Z0-9_])([A-Z]{2,5})-(\d+)(?![A-Z0-9_])/gi;
  for (const match of text.matchAll(re)) { const project = match[1]!.toUpperCase(), number = Number(match[2]); if (known.has(project) && number > 0 && Number.isSafeInteger(number)) found.add(project + "-" + number); }
  return [...found];
}
export function gitBranchName(key: string, title: string): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/g, "");
  return key.toLowerCase() + (slug ? "-" + slug : "");
}
export function decideStatus(input: { kind: GitKind; current: string; draft?: boolean; allLinkedMerged: boolean; allowReopen?: boolean }): string | undefined {
  if (input.current === "done" && !input.allowReopen) return undefined;
  switch (input.kind) {
    case "pr_opened": return input.draft ? "in_progress" : "in_review";
    case "pr_ready": return "in_review";
    case "pr_merged": return input.allLinkedMerged ? "done" : undefined;
    case "issue_opened": return "in_progress";
    case "issue_closed": return "done";
    default: return undefined;
  }
}
const asObj = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
const stamp = (s: unknown) => typeof s === "string" ? (Date.parse(s) || Date.now()) : Date.now();
export function normalizeGitHub(eventName: string, payload: unknown, projects: readonly string[]): GitEvent[] {
  const p = asObj(payload), repo = p.repository?.full_name ?? "", sender = p.sender?.login ?? "unknown";
  if (eventName === "pull_request") {
    const pr = asObj(p.pull_request), action = p.action; let kind: GitKind | undefined;
    if (action === "opened") kind = pr.draft ? "pr_opened" : "pr_ready";
    if (action === "ready_for_review" || action === "review_requested") kind = "pr_ready";
    if (action === "closed") kind = pr.merged ? "pr_merged" : "pr_closed";
    if (!kind) return [];
    const body = pr.body ?? "", keys = parseCardKeys([pr.title ?? "", body, pr.head?.ref ?? ""].join("\n"), projects);
    return keys.length ? [{ provider: "github", repo, kind, url: pr.html_url ?? "", title: pr.title ?? "", author: pr.user?.login ?? sender, branch: pr.head?.ref, sha: pr.head?.sha, timestamp: stamp(pr.updated_at), keys, externalId: String(pr.id ?? pr.number ?? ""), draft: !!pr.draft, closing: /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+/i.test(body) }] : [];
  }
  if (eventName === "push") {
    const ref = String(p.ref ?? "").replace(/^refs\/heads\//, "");
    return (p.commits ?? []).flatMap((c: any) => { const keys = parseCardKeys([ref, c.message ?? ""].join("\n"), projects); return keys.length ? [{ provider: "github" as const, repo, kind: "commit" as const, url: c.url ?? p.compare ?? "", title: c.message ?? "", author: c.author?.username ?? sender, sha: c.id, branch: ref, timestamp: stamp(c.timestamp), keys }] : []; });
  }
  if (eventName === "issues") {
    const i = asObj(p.issue), kind: GitKind | undefined = p.action === "opened" ? "issue_opened" : p.action === "closed" ? "issue_closed" : undefined;
    const keys = parseCardKeys([i.title ?? "", i.body ?? ""].join("\n"), projects);
    return kind && keys.length ? [{ provider: "github", repo, kind, url: i.html_url ?? "", title: i.title ?? "", author: i.user?.login ?? sender, timestamp: stamp(i.updated_at), keys, externalId: String(i.id ?? "") }] : [];
  }
  if (eventName === "pull_request_review") {
    const r = asObj(p.review), pr = asObj(p.pull_request), state = r.state;
    const kind: GitKind | undefined = state === "approved" ? "review_approved" : state === "changes_requested" ? "review_changes_requested" : undefined;
    const keys = parseCardKeys([pr.title ?? "", pr.body ?? "", pr.head?.ref ?? ""].join("\n"), projects);
    return kind && keys.length ? [{ provider: "github", repo, kind, url: r.html_url ?? pr.html_url ?? "", title: `Review ${state}: ${pr.title ?? "pull request"}`, author: r.user?.login ?? sender, timestamp: stamp(r.submitted_at), keys, externalId: String(pr.id ?? pr.number ?? "") }] : [];
  }
  if (eventName === "check_suite" || eventName === "status") {
    const suite = asObj(p.check_suite), status = asObj(p);
    const conclusion = eventName === "status" ? status.state : suite.conclusion;
    if (eventName === "check_suite" && p.action !== "completed") return [];
    const kind: GitKind | undefined = conclusion === "failure" || conclusion === "error" ? "ci_failed" : conclusion === "success" ? "ci_passed" : undefined;
    const keys = parseCardKeys([suite.head_branch ?? "", status.context ?? "", status.description ?? ""].join("\n"), projects);
    return kind && keys.length ? [{ provider: "github", repo, kind, url: suite.html_url ?? status.target_url ?? "", title: status.name ?? status.context ?? `CI ${conclusion}`, author: sender, sha: suite.head_sha ?? status.sha, timestamp: stamp(suite.updated_at ?? status.updated_at), keys }] : [];
  }
  return [];
}
export function normalizeGitLab(eventName: string, payload: unknown, projects: readonly string[], repoPath = ""): GitEvent[] {
  const p = asObj(payload), attrs = asObj(p.object_attributes), repo = p.project?.path_with_namespace ?? repoPath, author = p.user?.username ?? "unknown";
  let kind: GitKind | undefined;
  if (eventName === "Merge Request Hook") {
    if (attrs.action === "open" || attrs.action === "opened") kind = attrs.work_in_progress || attrs.draft ? "pr_opened" : "pr_ready";
    if (attrs.action === "ready") kind = "pr_ready";
    if (attrs.action === "merge" || attrs.state === "merged") kind = "pr_merged";
    if (attrs.action === "close" || attrs.state === "closed") kind = "pr_closed";
  }
  if (eventName === "Issue Hook") kind = attrs.action === "open" ? "issue_opened" : attrs.action === "close" ? "issue_closed" : undefined;
  if (eventName === "Pipeline Hook") kind = attrs.status === "failed" ? "ci_failed" : attrs.status === "success" ? "ci_passed" : undefined;
  if (eventName === "Note Hook") kind = "note";
  if (!kind) return [];
  const mr = asObj(p.merge_request), issue = asObj(p.issue), commit = asObj(p.commit), title = attrs.title ?? mr.title ?? issue.title ?? "", body = attrs.description ?? attrs.note ?? "", branch = attrs.source_branch ?? attrs.ref ?? commit.ref, keys = parseCardKeys([title, body, branch ?? "", mr.source_branch ?? ""].join("\n"), projects);
  return keys.length ? [{ provider: "gitlab", repo, kind, url: attrs.url ?? mr.url ?? issue.url ?? attrs.web_url ?? "", title: title || `CI ${attrs.status ?? "note"}`, author: attrs.last_commit?.author?.name ?? author, sha: attrs.last_commit?.id ?? commit.id, branch, timestamp: stamp(attrs.updated_at), keys, externalId: String(attrs.iid ?? attrs.id ?? ""), draft: !!(attrs.work_in_progress || attrs.draft), closing: /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+/i.test(body) }] : [];
}
