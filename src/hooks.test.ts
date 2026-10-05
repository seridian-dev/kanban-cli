import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractItemKeys, hookScript, hooksStatus, installHooks, outgoingCommitMessages, parsePushRefs, setActiveItem, readActiveItem } from "./hooks.js";

test("pre-push refs parse and malformed input fails closed", () => {
  assert.deepEqual(parsePushRefs("refs/heads/main abc refs/heads/main def\n"), [
    { localRef: "refs/heads/main", localSha: "abc", remoteRef: "refs/heads/main", remoteSha: "def" },
  ]);
  assert.throws(() => parsePushRefs("bad input"), /Invalid pre-push ref line/);
});

test("item references are normalized and de-duplicated", () => {
  assert.deepEqual(extractItemKeys(["Fix WEB-12", "KAN-185: more work\nWEB-12"]), ["WEB-12", "KAN-185"]);
});

test("managed hooks invoke the CLI stage check", () => {
  assert.match(hookScript("pre-commit"), /exec kanban hooks check --stage pre-commit/);
  assert.match(hookScript("pre-push"), /exec kanban hooks check --stage pre-push/);
});

test("installer is idempotent, records the active item, and preserves existing hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanban-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const hooksDir = join(root, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const first = await installHooks(root);
  assert.deepEqual(first.installed, ["pre-commit", "pre-push"]);
  assert.deepEqual(await installHooks(root), { installed: [] });
  assert.deepEqual(await hooksStatus(root), [
    { stage: "pre-commit", installed: true },
    { stage: "pre-push", installed: true },
  ]);
  await setActiveItem("WEB-12", root);
  assert.equal(await readActiveItem(root), "WEB-12");

  const customRoot = await mkdtemp(join(tmpdir(), "kanban-hooks-existing-"));
  execFileSync("git", ["init", "-q"], { cwd: customRoot });
  const customHook = join(customRoot, ".git", "hooks", "pre-commit");
  const contents = "#!/bin/sh\necho existing\n";
  await writeFile(customHook, contents);
  await assert.rejects(installHooks(customRoot), /Existing pre-commit hook left untouched/);
  assert.equal(await readFile(customHook, "utf8"), contents);
  assert.equal(await readFile(join(customRoot, ".git", "hooks", "pre-push"), "utf8").catch(() => ""), "");
});

test("outgoing commit messages are returned separately for per-commit checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanban-push-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "file.txt"), "first\n");
  execFileSync("git", ["add", "file.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "KAN-22 first change"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.deepEqual(outgoingCommitMessages([{ localRef: "refs/heads/main", localSha: head, remoteRef: "refs/heads/main", remoteSha: "0".repeat(40) }], root), [["KAN-22 first change"]]);
});
