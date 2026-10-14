/**
 * The one HTTP helper for the CLI. Every request (Convex calls, backend discovery, login, the
 * update check) goes through `createHttpFetch`, so retries, Retry-After handling and the
 * offline-versus-server classification live in one place.
 *
 * Retries: idempotent requests only (GET and HEAD, plus Convex query calls, which are POSTs).
 * Mutations and actions are sent once, because the server has no idempotency keys yet (KAN-201).
 * A retry happens on a network error, HTTP 429, or HTTP 500/502/503/504. Convex reports a failed
 * function as HTTP 560, which is never retried.
 */
export const BACKOFF_MS = [500, 1000, 2000, 4000];
/** A Retry-After longer than this fails at once instead of making the CLI sit idle. */
export const MAX_RETRY_AFTER_MS = 30_000;
const PROBE_TIMEOUT_MS = 3000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const QUERY_PATH = /\/api\/query(_at_ts|_ts)?$/;

/** Every transport failure exits with code 1. */
export class TransportError extends Error {
  readonly exitCode = 1;
}
/** The network is down: the site's own domain cannot be reached either. */
export class OfflineError extends TransportError {}
/** The site is reachable, but the server (or a rate limit) failed the request. */
export class ServerUnavailableError extends TransportError {}

export interface HttpPolicy {
  /** Retries after the first attempt, for idempotent requests. 0 means one attempt. */
  retries: number;
  /** The Kanban site. After a network failure it is probed to tell "offline" from "server error". */
  probeUrl?: string;
  /** The underlying fetch. Defaults to the global fetch, looked up on each call. */
  transport?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

export function isIdempotentRequest(url: string, init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  return method === "POST" && QUERY_PATH.test(new URL(url).pathname);
}

/** The wait before retry `attempt` (0-based): the base step, with ±25 % jitter. */
export function backoffMs(attempt: number, random: () => number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Retry-After as milliseconds, from either delay-seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function causeOf(error: unknown): string {
  let cur: unknown = error;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message : String(error);
}

function statusError(status: number): ServerUnavailableError {
  if (status === 429) return new ServerUnavailableError("Kanban is rate limiting requests (HTTP 429). Try again in a minute.");
  return new ServerUnavailableError(`Kanban server error (HTTP ${status}). Try again in a moment.`);
}

/** Asks the site whether it answers at all. Any HTTP response counts as reachable. */
async function reachable(url: string, transport: typeof fetch): Promise<boolean> {
  try {
    await transport(url, { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function networkFailure(error: unknown, policy: HttpPolicy, transport: typeof fetch): Promise<TransportError> {
  const cause = causeOf(error);
  if (!policy.probeUrl) return new ServerUnavailableError(`Could not reach the Kanban server (${cause}). Try again in a moment.`);
  const host = new URL(policy.probeUrl).host;
  if (!(await reachable(new URL("/", policy.probeUrl).href, transport))) {
    return new OfflineError(`You appear to be offline: cannot reach ${host}. Check your connection and try again.`);
  }
  return new ServerUnavailableError(`The Kanban server did not respond (${cause}), though ${host} is reachable, so the fault is on the server side. Try again in a moment.`);
}

/** A fetch with the CLI's retry and error policy. Pass it to ConvexHttpClient as its `fetch` option. */
export function createHttpFetch(policy: HttpPolicy): typeof fetch {
  const transport: typeof fetch = (input, init) => (policy.transport ?? globalThis.fetch)(input, init);
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = policy.random ?? Math.random;
  return async (input, init) => {
    const retries = isIdempotentRequest(urlOf(input), init) ? policy.retries : 0;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await transport(input, init);
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        if (attempt < retries) {
          await sleep(backoffMs(attempt, random));
          continue;
        }
        throw await networkFailure(error, policy, transport);
      }
      if (!RETRYABLE_STATUS.has(response.status)) return response;
      if (attempt >= retries) throw statusError(response.status);
      const after = retryAfterMs(response.headers.get("retry-after"), Date.now());
      if (after !== undefined && after > MAX_RETRY_AFTER_MS) {
        throw new ServerUnavailableError(`Kanban asked us to wait ${Math.ceil(after / 1000)} s before retrying. Try again later.`);
      }
      await response.body?.cancel().catch(() => {});
      await sleep(after ?? backoffMs(attempt, random));
    }
  };
}
