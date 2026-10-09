import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConvexError } from "convex/values";
import { anyApi, getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";
import { isTransientError, readRetriesFromEnv, TransientWriteError, wrapClient } from "./retry.js";
import { UsageError } from "./lib.js";

const SERVER_ERROR = new Error("[Request ID: abc] Server Error");

/** Fake client whose `query` and `mutation` throw the scripted errors, in order, before succeeding. */
function scripted(queryFailures: unknown[], mutationFailures: unknown[] = []) {
  const calls = { query: 0, mutation: 0 };
  const client = {
    async query() {
      calls.query++;
      if (queryFailures.length) throw queryFailures.shift();
      return { ok: true };
    },
    async mutation() {
      calls.mutation++;
      if (mutationFailures.length) throw mutationFailures.shift();
      return { ok: true };
    },
  };
  return { client: client as unknown as CliConvexClient, calls };
}

/** Fake for the CLI entry point: answers the setup reads, and fails `agentApi:getByKey` with `failures` first. */
function cliFake(failures: unknown[], mutationFailures: unknown[] = []) {
  const calls = { query: 0, mutation: 0 };
  const client = {
    async query(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      if (name === "agentApi:getByKey") {
        calls.query++;
        if (failures.length) throw failures.shift();
        return { _id: `id-${args.key}`, key: args.key, status: "todo", title: "T", type: "story" };
      }
      if (name === "preferences:getCliDefaults") return { workspaceSlug: null, projectKey: null };
      if (name === "projects:getByKey") return { _id: "p1", key: "WEB" };
      if (name === "projects:list") return [{ _id: "p1", key: "WEB", name: "Web" }];
      throw new Error(`unexpected query ${name}`);
    },
    async mutation() {
      calls.mutation++;
      if (mutationFailures.length) throw mutationFailures.shift();
      return { ok: true };
    },
  };
  return { client: client as unknown as CliConvexClient, calls };
}

/** Records sleeps instead of waiting, and uses the midpoint of the jitter range so delays are exact. */
function options(retries = 2) {
  const sleeps: number[] = [];
  return { sleeps, opts: { retries, sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5 } };
}

describe("isTransientError", () => {
  it("treats the redacted Server Error, network failures and 5xx bodies as transient", () => {
    assert.equal(isTransientError(SERVER_ERROR), true);
    assert.equal(isTransientError(new TypeError("fetch failed")), true);
    assert.equal(isTransientError(Object.assign(new Error("socket"), { code: "ECONNRESET" })), true);
    assert.equal(isTransientError(new Error("502 Bad Gateway")), true);
  });

  it("never treats a ConvexError with data or a not-found as transient", () => {
    assert.equal(isTransientError(new ConvexError("Cannot move to done with open children")), false);
    assert.equal(isTransientError(new Error("Item WEB-9 not found")), false);
    assert.equal(isTransientError(new Error("Invalid argument")), false);
  });
});

describe("read retries", () => {
  it("a read that fails twice with Server Error then succeeds returns the result after 3 calls", async () => {
    const { client, calls } = scripted([SERVER_ERROR, SERVER_ERROR]);
    const { sleeps, opts } = options();
    const result = await wrapClient(client, opts).query({} as never, {});
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.query, 3);
    assert.deepEqual(sleeps, [500, 1500]);
  });

  it("gives up after 3 attempts and rethrows the last error", async () => {
    const { client, calls } = scripted([SERVER_ERROR, SERVER_ERROR, SERVER_ERROR]);
    const { opts } = options();
    await assert.rejects(wrapClient(client, opts).query({} as never, {}), /Server Error/);
    assert.equal(calls.query, 3);
  });

  it("a ConvexError is not retried", async () => {
    const rule = new ConvexError("Cannot move to done with open children");
    const { client, calls } = scripted([rule]);
    const { opts } = options();
    await assert.rejects(wrapClient(client, opts).query({} as never, {}), rule);
    assert.equal(calls.query, 1);
  });

  it("a not-found is not retried", async () => {
    const { client, calls } = scripted([new Error("Item WEB-9 not found")]);
    const { opts } = options();
    await assert.rejects(wrapClient(client, opts).query({} as never, {}), /not found/);
    assert.equal(calls.query, 1);
  });

  it("KANBAN_RETRIES=0 makes exactly 1 call", async () => {
    const { client, calls } = scripted([SERVER_ERROR, SERVER_ERROR]);
    const { opts } = options(readRetriesFromEnv({ KANBAN_RETRIES: "0" }));
    await assert.rejects(wrapClient(client, opts).query({} as never, {}), /Server Error/);
    assert.equal(calls.query, 1);
  });

  it("rejects a KANBAN_RETRIES that is not a non-negative integer", () => {
    assert.equal(readRetriesFromEnv({}), 2);
    assert.equal(readRetriesFromEnv({ KANBAN_RETRIES: "5" }), 5);
    assert.throws(() => readRetriesFromEnv({ KANBAN_RETRIES: "many" }), UsageError);
    assert.throws(() => readRetriesFromEnv({ KANBAN_RETRIES: "-1" }), UsageError);
  });
});

describe("write failures", () => {
  it("a mutation failing with Server Error is called once and the message names the read command to check", async () => {
    const { client, calls } = scripted([], [SERVER_ERROR]);
    const { opts } = options();
    const error = await wrapClient(client, opts).mutation(anyApi.comments.add, {}).then(() => null, (e: unknown) => e);
    assert.equal(calls.mutation, 1);
    assert.ok(error instanceof TransientWriteError, "expected TransientWriteError");
    assert.match((error as Error).message, /may or may not have been applied/);
    assert.match((error as Error).message, /kanban comment list KEY/);
  });

  it("a mutation with a non-transient error is rethrown unchanged", async () => {
    const rule = new ConvexError("Item is locked");
    const { client } = scripted([], [rule]);
    const { opts } = options();
    await assert.rejects(wrapClient(client, opts).mutation(anyApi.comments.add, {}), rule);
  });
});

describe("through the CLI entry point", () => {
  const saved = process.env.KANBAN_RETRIES;

  it("comment add names `kanban comment list` when the write fails transiently, after one call", async () => {
    const { client, calls } = cliFake([], [SERVER_ERROR]);
    const sleeps: number[] = [];
    await assert.rejects(
      main(["comment", "add", "WEB-1", "--body", "hi"], { client, sleep: async (ms: number) => { sleeps.push(ms); } }),
      /kanban comment list KEY/,
    );
    assert.equal(calls.mutation, 1);
    assert.deepEqual(sleeps, []);
  });

  it("KANBAN_RETRIES=0 applies to reads through main", async () => {
    process.env.KANBAN_RETRIES = "0";
    try {
      const { client, calls } = cliFake([SERVER_ERROR, SERVER_ERROR]);
      await assert.rejects(main(["comment", "list", "WEB-1"], { client, sleep: async () => {} }), /Server Error/);
      assert.equal(calls.query, 1);
    } finally {
      if (saved === undefined) delete process.env.KANBAN_RETRIES;
      else process.env.KANBAN_RETRIES = saved;
    }
  });
});
