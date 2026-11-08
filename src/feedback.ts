import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { currentVersion } from "./update-check.js";
import { readAuth } from "./auth.js";
import { readConfig } from "./config.js";
import { createHttpFetch } from "./http.js";
import { platform, arch, release } from "node:os";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

export type FeedbackType = "bug" | "suggestion";

export interface SafeDiagnostics {
  cliVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  site?: string;
  command?: string;
  errorCode?: 1 | 2 | 3;
  errorKind?: "auth" | "offline" | "transport" | "not-found" | "usage" | "server" | "version" | "other";
  minimumVersion?: string;
  latestVersion?: string;
}

export interface FeedbackReport {
  type: FeedbackType;
  diagnostics: SafeDiagnostics;
  notes?: string;
  generatedAt: string;
}

const BUGS_URL = "https://github.com/seridian-dev/kanban-cli/issues";

export async function getBugsUrl(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { bugs?: { url?: string } };
    return pkg.bugs?.url || BUGS_URL;
  } catch {
    return BUGS_URL;
  }
}

export function sanitizeForReport(input: string): string {
  if (!input) return "";
  let out = input;
  // Redact obvious tokens / JWTs / bearer
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-TOKEN]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, "Bearer [REDACTED]");
  out = out.replace(/\b(ghp_|github_pat_)[A-Za-z0-9_]{10,}\b/g, "[REDACTED-GH-TOKEN]");
  // Redact long base64-ish secrets that are not short ids
  out = out.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, (m) => (m.length > 60 ? "[REDACTED]" : m));
  // Redact home-like paths and windows user paths (keep the last segment type for utility)
  out = out.replace(/(?:\/Users\/|\/home\/|C:\\Users\\)[^/\s\\"]+/gi, "~/.user");
  // Redact emails
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED-EMAIL]");
  // Strip full raw command lines that might have been pasted (keep only first word if looks like a kanban cmd)
  if (/\bkanban\s+[a-z-]+\s+/.test(out)) {
    out = out.replace(/\b(kanban\s+[a-z-]+\s+)[^\n]*/g, "$1[ARGS REDACTED]");
  }
  return out.trim();
}

export function inferErrorKind(message: string): SafeDiagnostics["errorKind"] {
  const m = (message || "").toLowerCase();
  if (/unauthenticated|not authenticated|invalid auth|login|token/i.test(m)) return "auth";
  if (/offline|cannot reach|connection|network/i.test(m)) return "offline";
  if (/server error|unavailable|rate limit|560|5\d\d/i.test(m)) return "server";
  if (/not found/i.test(m)) return "not-found";
  if (/usage|unknown command|needs a value|--/i.test(m)) return "usage";
  if (/transport|http|fetch|timeout/i.test(m)) return "transport";
  return "other";
}

export async function collectSafeDiagnostics(options: {
  command?: string;
  errorMessage?: string;
  errorCode?: 1 | 2 | 3;
  minimumVersion?: string;
  latestVersion?: string;
  site?: string;
}): Promise<SafeDiagnostics> {
  const cliVersion = await currentVersion();
  // site: only origin, never path or tokens
  let site: string | undefined;
  if (options.site) {
    try { site = new URL(options.site).origin; } catch { /* ignore */ }
  } else {
    try {
      const cfg = await readConfig().catch(() => ({}) as { site?: string });
      const auth = await readAuth().catch(() => null);
      const cand = (cfg && typeof (cfg as { site?: string }).site === "string" ? (cfg as { site?: string }).site : undefined) || auth?.site;
      if (cand) site = new URL(cand).origin;
    } catch { /* ignore */ }
  }
  const command = options.command ? options.command.split(/\s+/).slice(0, 2).join(" ") : undefined;
  const errorKind = options.errorMessage ? inferErrorKind(options.errorMessage) : undefined;
  return {
    cliVersion,
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    ...(site ? { site } : {}),
    ...(command ? { command } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(options.minimumVersion ? { minimumVersion: options.minimumVersion } : {}),
    ...(options.latestVersion ? { latestVersion: options.latestVersion } : {}),
  };
}

export function formatFeedbackMarkdown(report: FeedbackReport): string {
  const d = report.diagnostics;
  const lines: string[] = [];
  lines.push(`# Kanban CLI ${report.type === "suggestion" ? "Feature Suggestion" : "Bug Report"}`);
  lines.push("");
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Type:** ${report.type}`);
  lines.push("");
  lines.push("## Diagnostics (redacted)");
  lines.push(`- CLI version: ${d.cliVersion}`);
  lines.push(`- Node: ${d.nodeVersion}`);
  lines.push(`- OS: ${d.platform} ${d.arch} ${d.osRelease}`);
  if (d.site) lines.push(`- Site: ${d.site}`);
  if (d.command) lines.push(`- Command: ${d.command}`);
  if (d.errorCode !== undefined) lines.push(`- Error code: ${d.errorCode}`);
  if (d.errorKind) lines.push(`- Error kind: ${d.errorKind}`);
  if (d.minimumVersion) lines.push(`- Minimum required: ${d.minimumVersion}`);
  if (d.latestVersion) lines.push(`- Latest available: ${d.latestVersion}`);
  lines.push("");
  lines.push("## What happened");
  if (report.notes && report.notes.trim()) {
    lines.push(sanitizeForReport(report.notes));
  } else {
    lines.push("_Describe the symptoms, exact command (without secrets), and expected vs actual. Example: `kanban items move WEB-12 --status in_progress` exited 1 with '...'._");
  }
  lines.push("");
  lines.push("## Reproduction (sanitized)");
  lines.push("_Steps to reproduce. Include `kanban --version`, `node --version`, and the failing command without tokens or private data._");
  lines.push("");
  lines.push("## Privacy notice");
  lines.push("This template deliberately excludes auth tokens, secrets, full config files, board/card data, and file contents. Only the bounded diagnostics above and what you add are included. Review before posting.");
  lines.push("");
  lines.push("## Suggested fixes (if applicable)");
  if (d.errorKind === "auth") {
    lines.push("- Sign in again: `kanban login` (or `kanban login --code` over SSH).");
    lines.push("- Token is in `~/.config/kanban/auth.json` (owner-only). Run `kanban logout` then login to refresh.");
  } else if (d.errorKind === "offline" || d.errorKind === "transport") {
    lines.push("- Check network reachability to the Site above.");
    lines.push("- `KANBAN_RETRIES=0 kanban ...` for one attempt; increase with `KANBAN_RETRIES=N`.");
    lines.push("- If behind proxy or VPN, verify it allows the site.");
  } else if (d.errorKind === "version" || d.minimumVersion) {
    const cmd = typeof process.versions.bun === "string" ? "bun add -g @seridian/kanban-cli" : "npm i -g @seridian/kanban-cli";
    const target = d.minimumVersion ? `@${d.minimumVersion}` : "";
    lines.push(`- Upgrade required: \`${cmd}${target}\``);
    lines.push("- Then re-run your command. `kanban update check` shows the latest published version.");
    lines.push("- This CLI will not auto-update under npx, CI, or when KANBAN_NO_UPDATE=1.");
  } else {
    lines.push("- Run `kanban update check` and upgrade if available.");
    lines.push("- For auth problems: `kanban login`.");
    lines.push("- For connection problems: verify the site is reachable and retry.");
  }
  lines.push("");
  lines.push("## Environment");
  lines.push("```");
  lines.push(`cli: ${d.cliVersion}`);
  lines.push(`node: ${d.nodeVersion}`);
  lines.push(`os: ${d.platform}-${d.arch} ${d.osRelease}`);
  lines.push("```");
  if (report.notes) {
    lines.push("");
    lines.push("## Additional notes (user-provided)");
    lines.push(sanitizeForReport(report.notes));
  }
  return lines.join("\n");
}

export function buildGitHubNewIssueUrl(bugsUrl: string, title: string, body: string): string {
  const u = new URL(bugsUrl.replace(/\/$/, "") + "/new");
  // GitHub supports title and body query params for the form
  u.searchParams.set("title", title.slice(0, 256));
  // Body can be long; GitHub will truncate in the form but still useful.
  u.searchParams.set("body", body);
  return u.toString();
}

export async function buildReport(options: {
  type?: FeedbackType;
  command?: string;
  errorMessage?: string;
  errorCode?: 1 | 2 | 3;
  notes?: string;
  minimumVersion?: string;
  latestVersion?: string;
  site?: string;
}): Promise<{ report: FeedbackReport; markdown: string; submitUrl: string; bugsUrl: string }> {
  const type: FeedbackType = options.type ?? "bug";
  const diags = await collectSafeDiagnostics({
    command: options.command,
    errorMessage: options.errorMessage,
    errorCode: options.errorCode,
    minimumVersion: options.minimumVersion,
    latestVersion: options.latestVersion,
    site: options.site,
  });
  const report: FeedbackReport = {
    type,
    diagnostics: diags,
    notes: options.notes ? sanitizeForReport(options.notes) : undefined,
    generatedAt: new Date().toISOString(),
  };
  const md = formatFeedbackMarkdown(report);
  const bugsUrl = await getBugsUrl();
  const title = type === "suggestion"
    ? `[cli] Feature suggestion: ${diags.command ?? "general"}`
    : `[cli] ${diags.errorKind ?? "error"} in ${diags.command ?? "command"} (v${diags.cliVersion})`;
  const submitUrl = buildGitHubNewIssueUrl(bugsUrl, title, md);
  return { report, markdown: md, submitUrl, bugsUrl };
}
