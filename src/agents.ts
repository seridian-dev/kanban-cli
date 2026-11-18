/**
 * `kanban agents list|create|revoke` (KAN-367 follow-up). Thin wrappers over the server's agents.* functions.
 *
 * Every agents.* function needs a signed-in member. The caller is the stored `kanban login` session: kanban.ts builds
 * the Convex client with that token, so this module only checks that a session exists and never handles the token.
 * A new agent credential is returned by the server once; it is printed once, in the create result, and nowhere else.
 */
import { api } from "./api.js";
import type { CliConvexClient } from "./client.js";
import { formatTable, UsageError } from "./lib.js";

/** A command failure with its exit code (1 runtime or auth, 2 usage, 3 not found). */
export class CommandError extends Error {
  constructor(message: string, readonly code: 1 | 2 | 3) {
    super(message);
  }
}

/** The client values the server accepts (convex/schema.ts agentClient). */
export const AGENT_CLIENTS = ["claude_code", "codex", "chatgpt", "claude", "grok", "other"] as const;
const SCOPES = ["read", "write", "close"] as const;
const MAX_DAYS = 365;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,4}$/;

export interface AgentsInput {
  /** The authenticated client from createClient (the stored session is already attached). */
  client: Pick<CliConvexClient, "query" | "mutation">;
  sub: string | undefined;
  arg: string | undefined;
  flags: Record<string, string | true>;
  /** True when a `kanban login` session is stored. */
  signedIn: boolean;
  /** Workspace slug resolved by the caller (--workspace, KANBAN_WORKSPACE, linked folder, or saved default). */
  workspace: string | undefined;
}

export interface AgentsResult {
  data: unknown;
  human: string;
}

type Flags = Record<string, string | true>;
const text = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

function requireList(value: string, allowed: readonly string[], what: string): string[] {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new UsageError(`${what} needs at least one value`);
  for (const item of items) if (!allowed.includes(item)) throw new UsageError(`${what}: "${item}" is not one of ${allowed.join(", ")}`);
  return items;
}

export async function runAgents(input: AgentsInput): Promise<AgentsResult> {
  const { client, sub, arg, flags, signedIn, workspace: slug } = input;
  if (!signedIn) {
    throw new CommandError("kanban agents needs a signed-in session. Run `kanban login` first (the token is never printed).", 1);
  }
  if (sub !== "list" && sub !== "create" && sub !== "revoke") {
    throw new UsageError("Usage: kanban agents list|create|revoke [--workspace SLUG] ...");
  }
  if (sub !== "revoke" && !slug) throw new UsageError("Pick a workspace: --workspace SLUG, KANBAN_WORKSPACE, or `kanban config set workspace SLUG`");

  // Validate every local input before the first call, so a typo never reaches the server.
  let create: { name: string; client: string; scopes: string[]; expiresInDays?: number; projectKeys?: string[] } | undefined;
  let revokeId: string | undefined;
  if (sub === "create") {
    const name = text(flags, "name")?.trim();
    if (!name) throw new UsageError("--name is required");
    const clientId = text(flags, "client");
    if (!clientId || !(AGENT_CLIENTS as readonly string[]).includes(clientId)) {
      throw new UsageError(`--client must be one of ${AGENT_CLIENTS.join(", ")}`);
    }
    const scopes = requireList(text(flags, "scopes") ?? "read", SCOPES, "--scopes");
    let expiresInDays: number | undefined;
    if (text(flags, "days") !== undefined) {
      expiresInDays = Number(text(flags, "days"));
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_DAYS) throw new UsageError(`--days must be 1 to ${MAX_DAYS}`);
    }
    let projectKeys: string[] | undefined;
    const projects = text(flags, "projects");
    if (projects !== undefined) {
      projectKeys = projects.split(",").map((k) => k.trim().toUpperCase()).filter(Boolean);
      if (projectKeys.length === 0) throw new UsageError("--projects needs at least one project key, e.g. WEB,KAN");
      for (const key of projectKeys) if (!PROJECT_KEY.test(key)) throw new UsageError(`--projects: "${key}" is not a project key like WEB`);
    }
    create = { name, client: clientId, scopes, expiresInDays, projectKeys };
  }
  if (sub === "revoke") {
    revokeId = arg?.trim();
    if (!revokeId) throw new UsageError("Usage: kanban agents revoke AGENT_ID");
  }

  if (sub === "revoke") {
    // agents.revoke takes only the agent id; the server answers "not found" for anything the caller may not manage.
    await client.mutation(api.agents.revoke, { agentId: revokeId });
    return { data: { agentId: revokeId }, human: `Revoked ${revokeId}. Its credentials stop working now.` };
  }
  const workspace = (await client.query(api.organizations.getBySlug, { slug })) as { id: string; name: string } | null;
  if (!workspace) throw new CommandError(`Workspace ${slug} not found`, 3);

  if (sub === "list") {
    const result = (await client.query(api.agents.list, { organizationId: workspace.id })) as {
      agents: Array<{ id: string; name: string; client: string; ownerName: string; scopes: string[]; expiresAt: number | null; revokedAt: number | null }>;
    };
    const human = result.agents.length === 0
      ? "(no agents)"
      : formatTable(
        ["ID", "NAME", "CLIENT", "OWNER", "SCOPES", "STATUS"],
        result.agents.map((a) => [a.id, a.name, a.client, a.ownerName, a.scopes.join(","), a.revokedAt ? "revoked" : "active"]),
      );
    return { data: result, human };
  }

  const projectIds: string[] | undefined = create!.projectKeys
    ? await Promise.all(create!.projectKeys.map(async (key) => {
      const project = (await client.query(api.projects.getByKey, { key, workspaceSlug: slug })) as { _id: string } | null;
      if (!project) throw new CommandError(`Project ${key} not found`, 3);
      return project._id;
    }))
    : undefined;
  const created = (await client.mutation(api.agents.create, {
    organizationId: workspace.id,
    name: create!.name,
    client: create!.client,
    scopes: create!.scopes,
    ...(create!.expiresInDays !== undefined ? { expiresInDays: create!.expiresInDays } : {}),
    ...(projectIds ? { projectIds } : {}),
  })) as { agentId: string; token: string; name: string; scopes: string[]; expiresAt: number };
  const days = Math.max(1, Math.round((created.expiresAt - Date.now()) / 86_400_000));
  const human = [
    `Created agent ${created.name} (${created.scopes.join(",")}), expires in about ${days} days.`,
    "Credential, shown once. Store it in your client's secret setting now; it cannot be shown again:",
    created.token,
  ].join("\n");
  return { data: { agentId: created.agentId, name: created.name, scopes: created.scopes, expiresAt: created.expiresAt, token: created.token }, human };
}
