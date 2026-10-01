# Kanban CLI guide

The CLI talks to the same Convex functions as the web app. It is useful for small, explicit updates and for coding agents that need compact task context.

## Install

When the npm package is published:

```sh
npm install --global @seridian-dev/kanban-cli
```

To use the current preview from source:

```sh
git clone https://github.com/seridian-dev/kanban-cli.git
cd kanban-cli
bun install
bun run build
node dist/kanban.js agent-help
```

## Configure a development workspace

```sh
export KANBAN_URL=https://kanban.seridian.dev
kanban login
kanban auth whoami
export KANBAN_PROJECT=KAN
export KANBAN_USER="Dee or your agent label"
kanban agent-help
```

`KANBAN_USER` is an optional activity label. Sign in with `kanban login`; the CLI opens a browser and returns a short-lived session to this device. No Convex URL is needed. Use `kanban logout` to clear the local session.

## Everyday work

```sh
kanban items list --status in_progress --limit 15 --compact --json
kanban items get KAN-12 --json
kanban items move KAN-12 --status in_progress
kanban comment add KAN-12 --body "Progress: implementation started"
kanban changelog KAN
```

`KANBAN_PROJECT` supplies the default project key. Pass `--project KEY` when working across projects. Add `--json` for machine output, and combine `--compact` with `--limit` to keep output small.

## Common commands

```text
kanban projects list
kanban tree KAN
kanban items list --project KAN [--status S --assignee A --type T --epic KAN-1 --q text --limit N --compact]
kanban items get KAN-12
kanban items create --project KAN --type story --title "..."
kanban items update KAN-12 --status in_review
kanban items move KAN-12 --status in_progress
kanban items breakdown KAN-12 --text "Validate API @sam\nAdd review screen @dee"
kanban sprints list --project KAN
kanban comment add KAN-12 --body "..."
kanban changelog KAN [--write CHANGELOG.md]
kanban git status --project KAN
kanban agent-help
```

The full help text is available with `kanban help`. The server checks hierarchy, dependencies, project membership, and other write rules. Exit codes are `0` success, `1` server/runtime error, `2` invalid command, and `3` not found.

## Agent safety

1. Find a small, assigned slice with `items list` and `--limit`.
2. Inspect one card using `items get` before editing it.
3. Move it into progress and leave a brief comment as work proceeds.
4. Ask before destructive actions; `items rm` requires `--yes` and deletes the item subtree.
5. Never treat `KANBAN_USER` as an authentication token.
