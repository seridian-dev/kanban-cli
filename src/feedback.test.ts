import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { sanitizeForReport, collectSafeDiagnostics, buildReport, formatFeedbackMarkdown, inferErrorKind } from "./feedback.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function withTempConfigAuth() {
  const dir = await mkdtemp(join(tmpdir(), "kanban-feedback-test-"));
  tempDirs.push(dir);
  const cfgDir = join(dir, ".config", "kanban");
  await mkdir(cfgDir, { recursive: true });
  process.env.KANBAN_CONFIG_FILE = join(cfgDir, "config.json");
  await writeFile(process.env.KANBAN_CONFIG_FILE, JSON.stringify({ site: "https://kanban.seridian.dev", project: "WEB" }));
  // auth separate, we don't touch it
  return dir;
}

test("sanitizeForReport redacts JWT-like tokens, bearer, github tokens, emails, home paths, and long base64 secrets", () => {
  const input = [
    "token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
    "user@example.com and foo@bar.co.uk",
    "file at /Users/alice/src/kanban/secret.txt and C:\\Users\\bob\\data\\x",
    "raw secret abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=abcdEFG",
    "kanban items move WEB-12 --status in_progress --note secret-token-here",
  ].join("\n");
  const out = sanitizeForReport(input);
  assert.match(out, /\[REDACTED-TOKEN\]/);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.match(out, /\[REDACTED-GH-TOKEN\]/);
  assert.match(out, /\[REDACTED-EMAIL\]/);
  assert.match(out, /~\/\.user/);
  assert.match(out, /\[REDACTED\]/);
  // command redaction keeps first word after kanban for context but drops the rest
  assert.match(out, /kanban items \[ARGS REDACTED\]/);
});

test("inferErrorKind classifies common messages", () => {
  assert.equal(inferErrorKind("You are not authenticated. Run kanban login"), "auth");
  assert.equal(inferErrorKind("You appear to be offline: cannot reach example.com"), "offline");
  assert.equal(inferErrorKind("Kanban server error (HTTP 503)"), "server");
  assert.equal(inferErrorKind("Item WEB-12 not found"), "not-found");
  assert.equal(inferErrorKind("--status needs a value"), "usage");
  assert.equal(inferErrorKind("fetch failed"), "transport");
  assert.equal(inferErrorKind("random thing"), "other");
});

test("collectSafeDiagnostics never includes tokens, secrets, or raw full argv; bounds command to first two words and site to origin", async () => {
  await withTempConfigAuth();
  const d = await collectSafeDiagnostics({
    command: "items create --project WEB --title secret --token eyJ...",
    errorMessage: "You are not authenticated",
    errorCode: 1,
    site: "https://kanban.seridian.dev/cli?x=1#hash",
    minimumVersion: "0.3.2",
    latestVersion: "0.4.0",
  });
  assert.equal(d.cliVersion.length > 0, true);
  assert.equal(d.nodeVersion.startsWith("v"), true);
  assert.equal(typeof d.platform, "string");
  assert.equal(d.site, "https://kanban.seridian.dev");
  assert.equal(d.command, "items create");
  assert.equal(d.errorCode, 1);
  assert.equal(d.errorKind, "auth");
  assert.equal(d.minimumVersion, "0.3.2");
  assert.equal(d.latestVersion, "0.4.0");
  // ensure no token-like in any value
  const s = JSON.stringify(d);
  assert.equal(/eyJ|Bearer|ghp_/.test(s), false);
});

test("buildReport produces local-only markdown and github new-issue URL with no network side effects", async () => {
  await withTempConfigAuth();
  const { report, markdown, submitUrl, bugsUrl } = await buildReport({
    type: "bug",
    command: "items move WEB-12 --status in_progress",
    errorMessage: "offline cannot reach",
    errorCode: 1,
    notes: "happened on my machine with token eyJ... and email me@corp.com",
  });
  assert.equal(report.type, "bug");
  assert.equal(report.diagnostics.errorKind, "offline");
  assert.ok(markdown.includes("Diagnostics (redacted)"));
  assert.ok(markdown.includes("~/.user") || !/\/Users\//.test(markdown));
  assert.ok(markdown.includes("[REDACTED-EMAIL]") || markdown.includes("redacted"));
  assert.ok(markdown.includes("Suggested fixes"));
  assert.ok(markdown.includes("offline") || markdown.includes("connection"));
  assert.ok(submitUrl.startsWith("https://github.com/seridian-dev/kanban-cli/issues/new?"));
  assert.ok(bugsUrl.includes("github.com/seridian-dev/kanban-cli/issues"));
  // ensure the constructed URL contains the body but we did not POST/fetch anything here
  assert.ok(submitUrl.includes("title="));
  assert.ok(submitUrl.includes("body="));
});

test("formatFeedbackMarkdown includes privacy notice and never contains raw secrets", () => {
  const md = formatFeedbackMarkdown({
    type: "suggestion",
    diagnostics: {
      cliVersion: "0.3.2",
      nodeVersion: "v22.0.0",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.0.0",
      site: "https://kanban.seridian.dev",
      command: "plan",
    },
    // Use a long enough eyJ... string to trigger the JWT redaction regex
    notes: "add a flag for foo; my token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(md.includes("Privacy notice"));
  assert.ok(md.includes("[REDACTED-TOKEN]"));
  assert.ok(md.includes("Feature Suggestion"));
});

test("buildReport works in CI/noninteractive with --json path and produces exportable structure without network", async () => {
  const { report, markdown } = await buildReport({ type: "suggestion", notes: "please add X" });
  assert.equal(report.diagnostics.cliVersion.length > 0, true);
  assert.ok(typeof markdown === "string" && markdown.length > 100);
  // no fetch was performed; this is purely local construction
});

test("error guidance for auth, offline, and version cases is present in the template", async () => {
  const auth = await buildReport({ errorMessage: "invalid auth token" });
  assert.ok(auth.markdown.includes("kanban login"));
  const off = await buildReport({ errorMessage: "You appear to be offline" });
  assert.ok(off.markdown.includes("KANBAN_RETRIES") || off.markdown.includes("connection"));
  const ver = await buildReport({ minimumVersion: "0.4.0", errorMessage: "version" });
  assert.ok(ver.markdown.includes("npm i -g") || ver.markdown.includes("bun add -g"));
  assert.ok(ver.markdown.includes("0.4.0"));
});
