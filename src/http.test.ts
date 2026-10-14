import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, createHttpFetch, isIdempotentRequest, OfflineError, retryAfterMs, ServerUnavailableError } from "./http.js";

const CONVEX = "https://example.convex.cloud";
const SITE = "https://kanban.seridian.dev";

type Step = Response | Error;

/** Transport that answers each request with the next scripted step, and records method and URL. */
function scripted(steps: Step[]) {
  const calls: string[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const step = steps.shift();
    if (step === undefined) throw new Error(`unexpected request ${calls.at(-1)}`);
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { transport, calls };
}

function networkError(code: string) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

function policy(steps: Step[], retries = 4, probeUrl: string | undefined = undefined) {
  const { transport, calls } = scripted(steps);
  const sleeps: number[] = [];
  const fetcher = createHttpFetch({ retries, probeUrl, transport, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 });
  return { fetcher, calls, sleeps };
}

const text = (status: number, body = "down", headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe("backoff", () => {
  it("doubles from 0.5 s, 1 s, 2 s, 4 s with the jitter midpoint", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map((attempt) => backoffMs(attempt, () => 0.5)), [500, 1000, 2000, 4000, 4000, 4000]);
  });

  it("jitters each delay within plus or minus 25 percent", () => {
    assert.equal(backoffMs(0, () => 0), 375);
    assert.equal(backoffMs(0, () => 0.9999), 625);
  });
});

describe("Retry-After", () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  it("reads whole seconds", () => {
    assert.equal(retryAfterMs("3", now), 3000);
  });
  it("reads an HTTP date and never returns a negative wait", () => {
    assert.equal(retryAfterMs(new Date(now + 2000).toUTCString(), now), 2000);
    assert.equal(retryAfterMs(new Date(now - 5000).toUTCString(), now), 0);
  });
  it("ignores a missing or unparseable header", () => {
    assert.equal(retryAfterMs(null, now), undefined);
    assert.equal(retryAfterMs("soon", now), undefined);
  });
});

describe("isIdempotentRequest", () => {
  it("treats GET and HEAD as idempotent", () => {
    assert.equal(isIdempotentRequest(`${SITE}/api/cli/config`, undefined), true);
    assert.equal(isIdempotentRequest(`${SITE}/`, { method: "HEAD" }), true);
  });
  it("treats Convex query calls, which are POSTs, as idempotent", () => {
    for (const path of ["/api/query", "/api/query_ts", "/api/query_at_ts"]) {
      assert.equal(isIdempotentRequest(`${CONVEX}${path}`, { method: "POST" }), true, path);
    }
  });
  it("treats mutations and actions as not idempotent (the server has no idempotency keys)", () => {
    assert.equal(isIdempotentRequest(`${CONVEX}/api/mutation`, { method: "POST" }), false);
    assert.equal(isIdempotentRequest(`${CONVEX}/api/action`, { method: "POST" }), false);
  });
});

describe("retries on server and rate-limit responses", () => {
  it("retries a GET on 503 and returns the later success", async () => {
    const { fetcher, calls, sleeps } = policy([text(503), text(200, "ok")]);
    const response = await fetcher(`${SITE}/api/cli/config`);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [500]);
  });

  it("makes 5 attempts (4 retries) with waits of 0.5, 1, 2 and 4 s, then reports a server error", async () => {
    const { fetcher, calls, sleeps } = policy([text(503), text(503), text(503), text(503), text(503)]);
    await assert.rejects(fetcher(`${SITE}/api/cli/config`), (e: unknown) => e instanceof ServerUnavailableError && /HTTP 503/.test((e as Error).message));
    assert.equal(calls.length, 5);
    assert.deepEqual(sleeps, [500, 1000, 2000, 4000]);
  });

  it("retries 429 too", async () => {
    const { fetcher, calls } = policy([text(429), text(200, "ok")]);
    assert.equal((await fetcher(`${SITE}/api/cli/config`)).status, 200);
    assert.equal(calls.length, 2);
  });

  it("honors Retry-After in seconds instead of the backoff", async () => {
    const { fetcher, sleeps } = policy([text(429, "slow", { "Retry-After": "3" }), text(200, "ok")]);
    await fetcher(`${SITE}/api/cli/config`);
    assert.deepEqual(sleeps, [3000]);
  });

  it("fails at once, without waiting, when Retry-After is longer than 30 s", async () => {
    const { fetcher, calls, sleeps } = policy([text(429, "slow", { "Retry-After": "120" })]);
    await assert.rejects(fetcher(`${SITE}/api/cli/config`), (e: unknown) => e instanceof ServerUnavailableError && /try again later/i.test((e as Error).message));
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it("returns a Convex UDF failure (HTTP 560) to the client without retrying it", async () => {
    const { fetcher, calls } = policy([new Response("{}", { status: 560 })]);
    assert.equal((await fetcher(`${CONVEX}/api/query`, { method: "POST" })).status, 560);
    assert.equal(calls.length, 1);
  });

  it("does not retry other 4xx responses", async () => {
    const { fetcher, calls } = policy([text(400, "bad")]);
    assert.equal((await fetcher(`${SITE}/api/cli/config`)).status, 400);
    assert.equal(calls.length, 1);
  });
});

describe("which requests are retried", () => {
  it("retries a Convex query on 503", async () => {
    const { fetcher, calls } = policy([text(503), text(200, "{}")]);
    await fetcher(`${CONVEX}/api/query`, { method: "POST" });
    assert.equal(calls.length, 2);
  });

  it("never retries a Convex mutation, and reports the server error at once", async () => {
    const { fetcher, calls, sleeps } = policy([text(503)]);
    await assert.rejects(fetcher(`${CONVEX}/api/mutation`, { method: "POST" }), ServerUnavailableError);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it("never retries a Convex action", async () => {
    const { fetcher, calls } = policy([text(503)]);
    await assert.rejects(fetcher(`${CONVEX}/api/action`, { method: "POST" }), ServerUnavailableError);
    assert.equal(calls.length, 1);
  });

  it("with retries 0 (--no-retry or KANBAN_RETRIES=0) makes exactly one attempt", async () => {
    const { fetcher, calls } = policy([text(503), text(200)], 0);
    await assert.rejects(fetcher(`${SITE}/api/cli/config`), ServerUnavailableError);
    assert.equal(calls.length, 1);
  });

  it("does not retry a request the caller aborted", async () => {
    const { transport, calls } = scripted([Object.assign(new Error("aborted"), { name: "AbortError" })]);
    const fetcher = createHttpFetch({ retries: 4, transport, sleep: async () => {}, random: () => 0.5 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetcher(`${SITE}/`, { signal: controller.signal }), /aborted/);
    assert.equal(calls.length, 1);
  });
});

describe("network failures", () => {
  it("reports offline when the site is unreachable too (DNS failure)", async () => {
    const { fetcher, calls, sleeps } = policy([networkError("ENOTFOUND"), networkError("ENOTFOUND"), networkError("ENOTFOUND")], 1, SITE);
    await assert.rejects(fetcher(`${CONVEX}/api/query`, { method: "POST" }), (e: unknown) => {
      assert.ok(e instanceof OfflineError, "expected OfflineError");
      assert.match((e as Error).message, /offline/i);
      assert.match((e as Error).message, /kanban\.seridian\.dev/);
      return true;
    });
    assert.equal(calls.length, 3);
    assert.equal(calls.at(-1), `HEAD ${SITE}/`);
    assert.deepEqual(sleeps, [500]);
  });

  it("reports a server error when the site answers but the backend connection fails", async () => {
    const { fetcher } = policy([networkError("ECONNRESET"), networkError("ECONNRESET"), text(200)], 1, SITE);
    const error = await fetcher(`${CONVEX}/api/query`, { method: "POST" }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ServerUnavailableError, "expected ServerUnavailableError");
    assert.match((error as Error).message, /server side/i);
    assert.doesNotMatch((error as Error).message, /offline/i);
  });

  it("classifies a failed mutation without retrying it", async () => {
    const { fetcher, calls } = policy([networkError("ECONNREFUSED"), networkError("ENOTFOUND")], 4, SITE);
    await assert.rejects(fetcher(`${CONVEX}/api/mutation`, { method: "POST" }), OfflineError);
    assert.equal(calls.length, 2);
  });

  it("gives every transport error exit code 1", () => {
    assert.equal(new OfflineError("x").exitCode, 1);
    assert.equal(new ServerUnavailableError("x").exitCode, 1);
  });
});
