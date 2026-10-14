/**
 * Write-side policy for the Convex client. Reads retry inside the HTTP helper (http.ts). A write is
 * never retried: the server has no idempotency keys yet (KAN-201), so a retried create could duplicate
 * work. A transient write failure is reported with the read command that checks it.
 */
import { getFunctionName } from "convex/server";
import { UsageError } from "./lib.js";
import type { CliConvexClient } from "./client.js";
import { TransportError } from "./http.js";

/** A write whose outcome is unknown after a transient failure. */
export class TransientWriteError extends Error {}

const DEFAULT_RETRIES = 4;
const MAX_RETRIES = 10;

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

const TRANSIENT_MESSAGE = /Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|\bstatus 5\d\d\b|fetch failed|socket hang up|network error/i;

/**
 * Read `KANBAN_RETRIES`: the retries after the first attempt, an integer from 0 to 10, default 4.
 * Throws a UsageError otherwise.
 */
export function readRetriesFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.KANBAN_RETRIES;
  if (raw === undefined || raw === "") return DEFAULT_RETRIES;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n > MAX_RETRIES) throw new UsageError(`KANBAN_RETRIES must be an integer from 0 to ${MAX_RETRIES}, got "${raw}"`);
  return n;
}

/** True when a failure is worth treating as transient: a transport failure, or the kinds of server error that clear up. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof TransportError) return true;
  if (e && typeof e === "object" && "data" in e && (e as { data?: unknown }).data !== undefined) return false;
  const message = e instanceof Error ? e.message : String(e);
  if (/\bnot found\b/i.test(message)) return false;
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return TRANSIENT_MESSAGE.test(message);
}

/** The read to run before retrying a write, by mutation name. KEY stands for the item key. */
const CHECK_COMMAND: Readonly<Record<string, string>> = {
  "comments:add": "kanban comment list KEY",
  "workItems:create": "kanban items list --project PROJECT --compact",
};
const DEFAULT_CHECK = "kanban items get KEY";

function functionName(ref: unknown): string {
  try {
    return getFunctionName(ref as never);
  } catch {
    return "";
  }
}

function writeFailureMessage(name: string): string {
  const check = CHECK_COMMAND[name] ?? DEFAULT_CHECK;
  return `The write may or may not have been applied. Check with \`${check}\` before retrying, because a retry can duplicate it.`;
}

/**
 * Wraps the client for writes. A mutation is called once; a transient failure becomes a
 * TransientWriteError that names the check to run. Queries pass through unchanged, since the
 * HTTP helper already retries them.
 */
export function wrapClient(client: CliConvexClient): CliConvexClient {
  return {
    query: (ref, args) => client.query(ref, args),
    async mutation(ref, args) {
      try {
        return await client.mutation(ref, args);
      } catch (e) {
        if (!isTransientError(e)) throw e;
        const cause = e instanceof TransportError ? `${e.message} ` : "The write failed with a transient server error. ";
        throw new TransientWriteError(`${cause}${writeFailureMessage(functionName(ref))}`);
      }
    },
  };
}
