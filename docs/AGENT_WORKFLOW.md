# Kanban CLI workflow for coding agents

Use this guide when a user asks you to work from a Kanban card. It covers the whole loop: find the right project and task, inspect it, keep the card current, and report the result.

## 1. Check that the CLI is available and authorized

From the repository you are going to work on, run:

```sh
kanban agent-help
kanban auth whoami
```

If `kanban` is not on `PATH`, this CLI has not been published to npm yet. Use the checked-out CLI after it has been built, for example:

```sh
node /path/to/kanban-cli/dist/kanban.js agent-help
```

If the CLI reports that the device is not authorized or the session expired, tell the user that a one-time browser approval is needed and ask them to run `kanban login` in their terminal. The agent cannot finish that interactive approval on the user's behalf. After they approve the device, retry `kanban auth whoami`.

Never ask the user to paste a token or password into chat or a card comment. The CLI stores its session locally outside the repository.

## 2. Resolve the project before searching

Inspect the current folder's Kanban context:

```sh
kanban context
kanban config
kanban links list
```

The selected project is resolved in this order: `--project KEY`, `KANBAN_PROJECT`, the nearest linked folder, then the saved default project. Workspace selection uses `--workspace`, `KANBAN_WORKSPACE`, the nearest linked folder, then the saved default workspace.

If no project is selected, list the projects and use the key the user or repository configuration identifies:

```sh
kanban projects list --json
```

Do not choose a project just because its name seems plausible. If multiple workspaces contain the same project key, pass `--workspace SLUG`. If this repository should keep using one project, a human can link it once from its root:

```sh
kanban link --workspace WORKSPACE --project KEY
```

This writes local configuration under `~/.config/kanban/`; it does not edit the repository.

## 3. Find and inspect the task

For assigned work, set the exact assignee name used in Kanban. Replace `KEY` and `AGENT_NAME` with real values:

```sh
kanban items list --project KEY --assignee "AGENT_NAME" --status todo --limit 10 --compact --json
```

If no matching task appears, look at a small set of open items rather than dumping the whole board:

```sh
kanban items list --project KEY --status todo --limit 10 --compact --json
kanban tree KEY
```

Read a candidate card before touching the code:

```sh
kanban items get KEY-12 --json
```

Check its description, parent/epic, child tasks, dependencies, comments, acceptance criteria, and current status. If it is ambiguous, already owned, blocked by a dependency, or conflicts with the user's request, pause and report the mismatch instead of guessing.

## 4. Start work and keep updates useful

Once the user has asked you to do the card's work and the task is clear, move it to `in_progress` and leave a brief comment:

```sh
kanban items move KEY-12 --status in_progress
kanban comment add KEY-12 --body "Starting: <short scope>. Next: <first step>."
```

During longer work, comment when the scope, next step, or blocker changes. Keep comments short and factual. Do not post secrets, personal data, or large logs.

Use the repository's own instructions for implementation and verification. Do not broaden the task or make external changes that the user did not request.

## 5. Finish with evidence

Before changing the card to `done`, complete the requested work, run only the checks authorized by the user/repository instructions, and make sure no required work remains. Then post a concise summary with the checks actually performed:

```sh
kanban comment add KEY-12 --body "Done: <result>. Verified: <checks and outcome>."
kanban items move KEY-12 --status done
```

If implementation is complete but needs review, use `in_review` instead:

```sh
kanban comment add KEY-12 --body "Ready for review: <result>. Verified: <checks and outcome>."
kanban items move KEY-12 --status in_review
```

If blocked, leave the card open, explain the exact blocker and needed decision, and report it to the user:

```sh
kanban comment add KEY-12 --body "Blocked: <specific reason>. Needed: <decision/access/dependency>."
```

Do not claim a check passed unless you ran it. Do not mark incomplete or blocked work `done`.

## Guardrails

- Read `kanban agent-help` and `kanban items get` before acting.
- Use `--limit`, `--compact`, and `--json` to keep board output small and structured.
- Use explicit `--project`/`--workspace` if the local context is unclear.
- Never delete a card or its subtree unless the user explicitly asks. `kanban items rm` requires `--yes` and is destructive.
- Prefer updating or moving an existing card over creating duplicates.
- Do not change assignee, priority, dependencies, dates, or scope unless the user or task explicitly calls for it.
- The CLI cannot bypass Kanban's server-side hierarchy, dependency, membership, or write rules. If a write is rejected, read the error and report the actual constraint.

## Copyable instruction for an agent

```text
Use the Kanban CLI workflow in docs/AGENT_WORKFLOW.md. Start with `kanban agent-help`, `kanban auth whoami`, and `kanban context`. Resolve the intended project, find a small assigned task, read it with `kanban items get`, and confirm its scope before editing. Keep the card updated with short factual comments. Follow the target repository's instructions. Only mark work done after completing it and reporting checks actually run. Never delete cards without my explicit instruction.
```
