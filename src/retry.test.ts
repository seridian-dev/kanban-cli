import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConvexError } from "convex/values";
import { anyApi, getFunctionName } from "convex/server";
import { main } from "./kanban.js";
import type { CliConvexClient } from "./client.js";
import { isTransientError, readRetriesFromEnv, TransientWriteError, wrapClient } from "./retry.js";
import { UsageError } from "./lib.js";
import { OfflineError, TransportError } from "./http.js";

const SERVER_ERROR = new Error("[Request ID: abc] Server Error");

/** Fake client whose `mutation` throws the scripted errors, in order, before succeeding. */
function scripted(mutationFailures: unknown[]) {
  const calls = { mutation: 0 };
  const client = {
    async query() {
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

/** Fake for the CLI entry point: answers the item lookup and fails each mutation with `mutationFailures` first. */
function cliFake(mutationFailures: unknown[]) {
  const calls = { mutation: 0 };
  const client = {
    async query(ref: unknown, args: any) {
      const name = getFunctionName(ref as never);
      if (name === "agentApi:getByKey") return { _id: `id-${args.key}`, key: args.key, status: "todo", title: "T", type: "story" };
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

describe("isTransientError", () => {
  it("treats the redacted Server Error, network failures and 5xx bodies as transient", () => {
    assert.equal(isTransientError(SERVER_ERROR), true);
    assert.equal(isTransientError(new TypeError("fetch failed")), true);
    assert.equal(isTransientError(Object.assign(new Error("socket"), { code: "ECONNRESET" })), true);
    assert.equal(isTransientError(new Error("502 Bad Gateway")), true);
  });

  it("treats every transport error from the HTTP helper as transient", () => {
    assert.equal(isTransientError(new OfflineError("You appear to be offline")), true);
    assert.equal(isTransientError(new TransportError("x")), true);
  });

  it("never treats a ConvexError with data or a not-found as transient", () => {
    assert.equal(isTransientError(new ConvexError("Cannot move to done with open children")), false);
    assert.equal(isTransientError(new Error("Item WEB-9 not found")), false);
    assert.equal(isTransientError(new Error("Invalid argument")), false);
  });
});

describe("KANBAN_RETRIES", () => {
  it("defaults to 4 retries and accepts integers from 0 to 10", () => {
    assert.equal(readRetriesFromEnv({}), 4);
    assert.equal(readRetriesFromEnv({ KANBAN_RETRIES: "0" }), 0);
    assert.equal(readRetriesFromEnv({ KANBAN_RETRIES: "10" }), 10);
  });

  it("rejects a value that is not a non-negative integer, or is above 10", () => {
    assert.throws(() => readRetriesFromEnv({ KANBAN_RETRIES: "many" }), UsageError);
    assert.throws(() => readRetriesFromEnv({ KANBAN_RETRIES: "-1" }), UsageError);
    assert.throws(() => readRetriesFromEnv({ KANBAN_RETRIES: "11" }), UsageError);
  });
});

describe("write failures", () => {
  it("a mutation failing with Server Error is called once and the message names the read command to check", async () => {
    const { client, calls } = scripted([SERVER_ERROR]);
    const error = await wrapClient(client).mutation(anyApi.comments.add, {}).then(() => null, (e: unknown) => e);
    assert.equal(calls.mutation, 1);
    assert.ok(error instanceof TransientWriteError, "expected TransientWriteError");
    assert.match((error as Error).message, /may or may not have been applied/);
    assert.match((error as Error).message, /kanban comment list KEY/);
  });

  it("keeps the offline message and still names the check for a failed write", async () => {
    const { client, calls } = scripted([new OfflineError("You appear to be offline: cannot reach kanban.seridian.dev.")]);
    const error = await wrapClient(client).mutation(anyApi.comments.add, {}).then(() => null, (e: unknown) => e);
    assert.equal(calls.mutation, 1);
    assert.match((error as Error).message, /You appear to be offline/);
    assert.match((error as Error).message, /kanban comment list KEY/);
  });

  it("a mutation with a non-transient error is rethrown unchanged", async () => {
    const rule = new ConvexError("Item is locked");
    const { client } = scripted([rule]);
    await assert.rejects(wrapClient(client).mutation(anyApi.comments.add, {}), rule);
  });
});

/** Routes Convex and backend requests to a fake transport. Every Convex query gets a 503 and every request is counted. */
function alwaysUnavailable() {
  const calls: string[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response("down", { status: 503 });
  }) as typeof fetch;
  const sleeps: number[] = [];
  return { transport, calls, sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

describe("through the CLI entry point", () => {
  const saved = { retries: process.env.KANBAN_RETRIES, url: process.env.KANBAN_URL };
  process.env.KANBAN_URL = "http://127.0.0.1:3210";
  const restore = () => {
    if (saved.retries === undefined) delete process.env.KANBAN_RETRIES; else process.env.KANBAN_RETRIES = saved.retries;
    if (saved.url === undefined) delete process.env.KANBAN_URL; else process.env.KANBAN_URL = saved.url;
  };

  it("comment add names `kanban comment list` when the write fails transiently, after one call", async () => {
    const { client, calls } = cliFake([SERVER_ERROR]);
    const sleeps: number[] = [];
    await assert.rejects(
      main(["comment", "add", "WEB-1", "--body", "hi"], { client, sleep: async (ms: number) => { sleeps.push(ms); } }),
      /kanban comment list KEY/,
    );
    assert.equal(calls.mutation, 1);
    assert.deepEqual(sleeps, []);
  });

  it("a read retries a Convex query 4 times by default, with the backoff waits", async () => {
    delete process.env.KANBAN_RETRIES;
    try {
      const fake = alwaysUnavailable();
      await assert.rejects(main(["comment", "list", "WEB-1"], { fetch: fake.transport, sleep: fake.sleep }), /HTTP 503/);
      assert.equal(fake.calls.length, 5);
      // Waits are jittered by +/-25 % around the 0.5, 1, 2 and 4 s steps.
      const bases = [500, 1000, 2000, 4000];
      assert.equal(fake.sleeps.length, 4);
      fake.sleeps.forEach((ms, i) => assert.ok(ms >= bases[i] * 0.75 && ms <= bases[i] * 1.25, `wait ${i} was ${ms}`));
    } finally { restore(); }
  });

  it("--no-retry makes a single attempt", async () => {
    const fake = alwaysUnavailable();
    await assert.rejects(main(["comment", "list", "WEB-1", "--no-retry"], { fetch: fake.transport, sleep: fake.sleep }), /HTTP 503/);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.sleeps, []);
  });

  it("KANBAN_RETRIES=0 makes a single attempt", async () => {
    process.env.KANBAN_RETRIES = "0";
    try {
      const fake = alwaysUnavailable();
      await assert.rejects(main(["comment", "list", "WEB-1"], { fetch: fake.transport, sleep: fake.sleep }), /HTTP 503/);
      assert.equal(fake.calls.length, 1);
    } finally { restore(); }
  });

  it("with no network, the CLI reports offline as a transport error with exit code 1", async () => {
    process.env.KANBAN_URL = "https://kanban.example.test";
    try {
      const offline = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) }); }) as typeof fetch;
      const error = await main(["comment", "list", "WEB-1"], { fetch: offline, sleep: async () => {} }).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof OfflineError, "expected OfflineError");
      assert.equal((error as TransportError).exitCode, 1);
      assert.match((error as Error).message, /offline/);
    } finally { restore(); }
  });
});

