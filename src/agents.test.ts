import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import { api } from "./api.js";
import { CommandError, runAgents } from "./agents.js";
import { UsageError } from "./lib.js";

const TOKEN = "kbn_agt_FAKE"; // obviously fake fixture; never a real credential
const ORG = "org_1";

type Call = { op: "query" | "mutation"; ref: unknown; args: Record<string, unknown> };

/** A fake Convex client: records every call and never touches the network. */
function fakeClient(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const reply = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name in responses) return responses[name];
    throw new Error(`unexpected call ${name}`);
  };
  const client = {
    async query(ref: unknown, args: Record<string, unknown>) { calls.push({ op: "query", ref, args }); return reply(ref); },
    async mutation(ref: unknown, args: Record<string, unknown>) { calls.push({ op: "mutation", ref, args }); return reply(ref); },
  };
  return { client: client as never, calls };
}

const WORKSPACE = { id: ORG, name: "Acme", slug: "acme", plan: "pro", role: "owner" };

// anyApi builds a new reference object on every access, so calls are compared by function name, never by identity.
const nameOf = (call: Call) => getFunctionName(call.ref as never);
const summary = (call: Call) => ({ op: call.op, name: nameOf(call), args: call.args });

describe("kanban agents", () => {
  it("refuses before any call when the CLI is not signed in (exit 1, points at kanban login)", async () => {
    const fake = fakeClient();
    await assert.rejects(
      runAgents({ client: fake.client, sub: "list", arg: undefined, flags: {}, signedIn: false, workspace: "acme" }),
      (error: unknown) => error instanceof CommandError && error.code === 1 && /kanban login/.test(error.message),
    );
    assert.equal(fake.calls.length, 0);
  });

  it("list resolves the workspace slug and calls agents.list with its id", async () => {
    const fake = fakeClient({ "organizations:getBySlug": WORKSPACE, "agents:list": { policy: { allowClose: false, canManage: true }, agents: [] } });
    const result = await runAgents({ client: fake.client, sub: "list", arg: undefined, flags: {}, signedIn: true, workspace: "acme" });
    assert.equal(getFunctionName(fake.calls[0].ref as never), "organizations:getBySlug");
    assert.deepEqual(summary(fake.calls[1]), { op: "query", name: "agents:list", args: { organizationId: ORG } });
    assert.equal(result.human, "(no agents)");
  });

  it("list prints a table without any credential", async () => {
    const agents = [{ id: "agent_1", name: "Claude", client: "claude_code", ownerName: "Rod", scopes: ["read", "write"], expiresAt: null, revokedAt: null }];
    const fake = fakeClient({ "organizations:getBySlug": WORKSPACE, "agents:list": { policy: { allowClose: false, canManage: true }, agents } });
    const result = await runAgents({ client: fake.client, sub: "list", arg: undefined, flags: {}, signedIn: true, workspace: "acme" });
    assert.match(result.human, /agent_1.*Claude.*claude_code.*read,write.*active/);
  });

  it("a workspace is required for list and create (exit 2)", async () => {
    const fake = fakeClient();
    await assert.rejects(runAgents({ client: fake.client, sub: "list", arg: undefined, flags: {}, signedIn: true, workspace: undefined }), UsageError);
    assert.equal(fake.calls.length, 0);
  });

  it("an unknown workspace is not found (exit 3)", async () => {
    const fake = fakeClient({ "organizations:getBySlug": null });
    await assert.rejects(
      runAgents({ client: fake.client, sub: "list", arg: undefined, flags: {}, signedIn: true, workspace: "nope" }),
      (error: unknown) => error instanceof CommandError && error.code === 3,
    );
  });

  it("create prints the token exactly once and sends the validated fields", async () => {
    const created = { agentId: "agent_1", token: TOKEN, name: "Claude", scopes: ["read", "write"], expiresAt: Date.now() + 30 * 86_400_000 };
    const fake = fakeClient({ "organizations:getBySlug": WORKSPACE, "agents:create": created });
    const result = await runAgents({
      client: fake.client, sub: "create", arg: undefined, signedIn: true, workspace: "acme",
      flags: { name: "Claude", client: "claude_code", scopes: "read,write", days: "30" },
    });
    assert.deepEqual(summary(fake.calls[1]), {
      op: "mutation", name: "agents:create",
      args: { organizationId: ORG, name: "Claude", client: "claude_code", scopes: ["read", "write"], expiresInDays: 30 },
    });
    assert.equal(result.human.split(TOKEN).length - 1, 1, "token appears once in the human output");
    assert.equal((result.data as { token: string }).token, TOKEN, "the create result carries the token for --json");
  });

  it("create resolves --projects keys to project ids (WEB,KAN are both accepted)", async () => {
    const created = { agentId: "agent_2", token: TOKEN, name: "Codex", scopes: ["read"], expiresAt: Date.now() + 86_400_000 };
    const fake = fakeClient({
      "organizations:getBySlug": WORKSPACE,
      "projects:getByKey": { _id: "proj_web" },
      "agents:create": created,
    });
    await runAgents({
      client: fake.client, sub: "create", arg: undefined, signedIn: true, workspace: "acme",
      flags: { name: "Codex", client: "codex", projects: "web, kan" },
    });
    const lookups = fake.calls.filter((c) => nameOf(c) === "projects:getByKey");
    assert.deepEqual(lookups.map((c) => c.args.key), ["WEB", "KAN"]);
    assert.ok(lookups.every((c) => c.args.workspaceSlug === "acme"), "project keys resolve inside the workspace");
    assert.deepEqual(fake.calls.at(-1)?.args.projectIds, ["proj_web", "proj_web"]);
  });

  it("an unknown project in --projects is not found (exit 3)", async () => {
    const fake = fakeClient({ "organizations:getBySlug": WORKSPACE, "projects:getByKey": null });
    await assert.rejects(
      runAgents({ client: fake.client, sub: "create", arg: undefined, signedIn: true, workspace: "acme", flags: { name: "x", client: "codex", projects: "NOPE" } }),
      (error: unknown) => error instanceof CommandError && error.code === 3,
    );
  });

  it("create validates the name, client and scopes before calling the server", async () => {
    const fake = fakeClient({ "organizations:getBySlug": WORKSPACE });
    const base = { client: fake.client, sub: "create", arg: undefined, signedIn: true, workspace: "acme" };
    await assert.rejects(runAgents({ ...base, flags: { name: "x", client: "gemini" } }), UsageError);
    await assert.rejects(runAgents({ ...base, flags: { name: "x", client: "codex", scopes: "read,fly" } }), UsageError);
    await assert.rejects(runAgents({ ...base, flags: { name: "x", client: "codex", days: "400" } }), UsageError);
    await assert.rejects(runAgents({ ...base, flags: { client: "codex" } }), UsageError);
    assert.equal(fake.calls.filter((c) => nameOf(c) === "agents:create").length, 0);
    assert.equal(fake.calls.length, 0, "no server call at all: validation runs before the workspace lookup");
  });

  it("revoke takes an agent id and calls agents.revoke; a missing id is a usage error", async () => {
    const fake = fakeClient({ "agents:revoke": null });
    const result = await runAgents({ client: fake.client, sub: "revoke", arg: "agent_1", flags: {}, signedIn: true, workspace: undefined });
    assert.deepEqual(summary(fake.calls[0]), { op: "mutation", name: "agents:revoke", args: { agentId: "agent_1" } });
    assert.match(result.human, /Revoked agent_1/);
    await assert.rejects(runAgents({ client: fake.client, sub: "revoke", arg: undefined, flags: {}, signedIn: true, workspace: undefined }), UsageError);
  });

  it("an unknown subcommand is a usage error", async () => {
    const fake = fakeClient();
    await assert.rejects(runAgents({ client: fake.client, sub: "rotate", arg: undefined, flags: {}, signedIn: true, workspace: "acme" }), UsageError);
    assert.equal(fake.calls.length, 0);
  });
});
