import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBackendUrl } from "./backend.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("resolveBackendUrl", () => {
  it("uses local Convex URLs for development", async () => {
    assert.equal(await resolveBackendUrl("http://127.0.0.1:3210"), "http://127.0.0.1:3210");
  });
  it("discovers the backend from the product URL", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.equal(String(input), "https://kanban.seridian.dev/api/cli/config");
      return Response.json({ convexUrl: "https://example.convex.cloud" });
    }) as typeof fetch;
    assert.equal(await resolveBackendUrl("https://kanban.seridian.dev/"), "https://example.convex.cloud");
  });
  it("rejects insecure non-local product URLs", async () => {
    await assert.rejects(resolveBackendUrl("http://kanban.seridian.dev"), /must use HTTPS/);
  });
});
