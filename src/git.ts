import { api } from "./api.js";
import type { CliConvexClient } from "./client.js";
import { parseKey } from "./lib.js";
import { gitBranchName } from "./git-utils.js";

export async function runGit(client: CliConvexClient, command: string | undefined, arg: string | undefined, flags: Record<string, string | true>, actor: string) {
  const projectKey = typeof flags.project === "string" ? flags.project.toUpperCase() : process.env.KANBAN_PROJECT?.toUpperCase();
  if (command === "branch") {
    const key = arg ?? "";
    if (!parseKey(key)) throw new Error("git branch requires an item key such as KAN-12");
    const detail = await client.query(api.agentApi.detail, { key });
    if (!detail) throw new Error("Item " + key + " not found");
    const branch = gitBranchName(detail.item.key, detail.item.title);
    return { data: { key: detail.item.key, branch }, human: branch };
  }
  if (!projectKey) throw new Error("--project KEY is required (or set KANBAN_PROJECT)");
  const project = await client.query(api.projects.getByKey, { key: projectKey });
  if (!project) throw new Error("Project " + projectKey + " not found");
  if (command === "connect") {
    const provider = flags.provider, repo = flags.repo;
    if (provider !== "github" && provider !== "gitlab") throw new Error("--provider github|gitlab is required");
    if (typeof repo !== "string" || !repo) throw new Error("--repo is required");
    const result = await client.mutation(api.integrations.connections.connect, { projectId: project._id, provider, repo, host: typeof flags.host === "string" ? flags.host : undefined, actor });
    const url = (process.env.KANBAN_WEBHOOK_URL ?? "https://<deployment>.convex.site") + "/webhooks/" + provider;
    return { data: { ...result, webhookUrl: url }, human: "Webhook URL: " + url + "\nSecret (shown once): " + result.secret };
  }
  if (command === "status") {
    const rows = await client.query(api.integrations.connections.list, { projectId: project._id });
    return { data: rows, human: rows.length ? rows.map((r) => r.provider + " " + r.repo + " " + (r.enabled ? "enabled" : "disabled")).join("\n") : "(no git connections)" };
  }
  if (command === "links") {
    if (!arg || !parseKey(arg)) throw new Error("git links requires an item key such as KAN-12");
    const item = await client.query(api.agentApi.getByKey, { key: arg });
    if (!item) throw new Error("Item " + arg + " not found");
    const rows = await client.query(api.integrations.connections.listLinks, { workItemId: item._id });
    return { data: rows, human: rows.length ? rows.map((r) => r.provider + " " + r.kind + " " + r.state + " " + r.url).join("\n") : "(no git links)" };
  }
  if (command === "prs") {
    const rows = await client.query(api.integrations.connections.listOpenPullRequests, { projectId: project._id });
    const items = await client.query(api.workItems.listByProject, { projectId: project._id });
    const byId = new Map<string, any>(items.map((item: any) => [String(item._id), item]));
    const data = rows.map((link: any) => ({ key: byId.get(String(link.workItemId))?.key, title: byId.get(String(link.workItemId))?.title, provider: link.provider, state: link.state, url: link.url, name: link.title })).filter((row: any) => row.key);
    return { data, human: data.length ? data.map((row) => `${row.key} ${row.provider} ${row.state} ${row.url}`).join("\n") : "(no open pull requests)" };
  }
  if (command === "rotate-secret") {
    const id = flags.connection;
    if (typeof id !== "string") throw new Error("--connection ID is required");
    const result = await client.mutation(api.integrations.connections.rotateSecret, { connectionId: id as never });
    return { data: result, human: "Secret (shown once): " + result.secret };
  }
  throw new Error("Unknown git command. Supported: connect, status, links, prs, branch, rotate-secret");
}
