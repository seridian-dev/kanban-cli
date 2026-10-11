import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BOOLEAN_FLAGS } from "./lib.js";
import { FULL_HELP } from "./help.js";
import { COMMANDS, booleanFlagNames, findCommand, schemaDocument, schemaVersion } from "./schema.js";

const KANBAN = new URL("./kanban.js", import.meta.url).pathname;

/** Groups whose second word is a subcommand (`kanban items get`), not an argument. */
const GROUPS_WITH_SUBCOMMANDS = new Set(["auth", "projects", "folders", "items", "comment", "sprints", "git", "gh", "links", "hooks", "config", "update"]);

function helpCommandKeys(help: string): Set<string> {
  const keys = new Set<string>();
  for (const line of help.split("\n")) {
    for (const m of line.matchAll(/\bkanban ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const [, group, sub] = m;
      keys.add(GROUPS_WITH_SUBCOMMANDS.has(group) && sub ? `${group} ${sub}` : group);
    }
  }
  return keys;
}

test("schema boolean flags match BOOLEAN_FLAGS in both directions", () => {
  assert.deepEqual(booleanFlagNames(), [...BOOLEAN_FLAGS].sort());
});

test("every command in FULL_HELP appears in the schema", () => {
  const known = new Set(COMMANDS.map((c) => c.command));
  const helpKeys = helpCommandKeys(FULL_HELP);
  assert.ok(helpKeys.size > 40, `expected many commands in help, found ${helpKeys.size}`);
  const missing = [...helpKeys].filter((key) => !known.has(key));
  assert.deepEqual(missing, [], `commands in FULL_HELP missing from schema COMMANDS`);
});

test("command entries are unique and well formed", () => {
  const names = COMMANDS.map((c) => c.command);
  assert.equal(new Set(names).size, names.length, "duplicate command");
  for (const c of COMMANDS) {
    assert.ok(c.summary.length > 0, `${c.command} needs a summary`);
    const flagNames = c.flags.map((f) => f.name);
    assert.equal(new Set(flagNames).size, flagNames.length, `${c.command} repeats a flag`);
    for (const f of c.flags) {
      if (f.values) assert.ok(f.values.length > 0, `${c.command} --${f.name} has empty values`);
    }
  }
});

test("enum values match the statuses, types, and priorities documented in FULL_HELP", () => {
  const statuses = /Statuses: ([^.]+)\./.exec(FULL_HELP)?.[1].split(" ");
  const types = /Types: ([^.]+)\./.exec(FULL_HELP)?.[1].split(" ");
  const priorities = /Priorities: ([^.]+)\./.exec(FULL_HELP)?.[1].split(" ");
  const flagValues = (command: string, flag: string) => findCommand(command.split(" "))?.flags.find((f) => f.name === flag)?.values;
  assert.deepEqual(flagValues("items move", "status"), statuses);
  assert.deepEqual(flagValues("items create", "type"), types);
  assert.deepEqual(flagValues("items create", "priority"), priorities);
});

test("destructive commands are exactly the ones that delete or invalidate data", () => {
  const destructive = COMMANDS.filter((c) => c.destructive).map((c) => c.command).sort();
  assert.deepEqual(destructive, ["folders delete", "git rotate-secret", "items rm"]);
  const rm = findCommand(["items", "rm"]);
  assert.equal(rm?.flags.find((f) => f.name === "yes")?.required, true);
});

test("the schema document reports the package version and every command", () => {
  const doc = schemaDocument();
  assert.equal(doc.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(doc.version, schemaVersion());
  assert.equal(doc.commands.length, COMMANDS.length);
});

test("kanban schema prints the document as JSON", () => {
  const run = spawnSync(process.execPath, [KANBAN, "schema"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.version, schemaVersion());
  assert.equal(parsed.commands.length, COMMANDS.length);
});

test("kanban schema <command words> prints one command", () => {
  const run = spawnSync(process.execPath, [KANBAN, "schema", "items", "create"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.command, "items create");
  assert.equal(parsed.flags.find((f: { name: string }) => f.name === "type").required, true);
});

test("kanban schema for an unknown command exits 3 with JSON on stderr", () => {
  const run = spawnSync(process.execPath, [KANBAN, "schema", "nope"], { encoding: "utf8" });
  assert.equal(run.status, 3);
  assert.equal(JSON.parse(run.stderr).code, 3);
});
