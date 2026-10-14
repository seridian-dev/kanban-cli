export const DEFAULT_KANBAN_URL = "https://kanban.seridian.dev";

const validHttpsOrLocal = (candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch { return false; }
};
const isDirectBackend = (candidate: string): boolean => {
  try {
    const url = new URL(candidate);
    return validHttpsOrLocal(candidate) && (url.hostname.endsWith(".convex.cloud") || url.hostname.endsWith(".convex.site") || ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch { return false; }
};

/** `fetcher` is the CLI's HTTP helper (http.ts); the default is the plain global fetch. */
export async function resolveBackendUrl(productUrl: string, fetcher: typeof fetch = fetch): Promise<string> {
  const candidate = productUrl.trim().replace(/\/$/, "");
  if (isDirectBackend(candidate)) return candidate;

  let site: URL;
  try { site = new URL(candidate); }
  catch { throw new Error("Use a Kanban product URL such as https://kanban.seridian.dev"); }
  if (site.protocol !== "https:" && !(site.protocol === "http:" && ["localhost", "127.0.0.1"].includes(site.hostname))) {
    throw new Error("Kanban product URL must use HTTPS");
  }

  const response = await fetcher(new URL("/api/cli/config", site));
  if (!response.ok) throw new Error(`Kanban backend discovery failed (${response.status})`);
  const data: unknown = await response.json();
  const url = typeof data === "object" && data !== null && "convexUrl" in data
    ? (data as { convexUrl?: unknown }).convexUrl : undefined;
  if (typeof url !== "string" || !validHttpsOrLocal(url)) throw new Error("Kanban returned an invalid backend URL");
  return url;
}
