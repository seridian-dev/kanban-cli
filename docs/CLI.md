# Kanban CLI guide

Use this guide to work with Kanban from a terminal or coding agent. The CLI signs in through your browser and finds the server from `kanban.seridian.dev`; you do not need a Convex URL or API key.

## Install

The npm release is not available yet. Install the public source version:

```sh
git clone https://github.com/seridian-dev/kanban-cli.git
cd kanban-cli
npm install
npm link
kanban login
```

Your browser opens. Sign in to Kanban and choose **Authorize CLI**. After approval, return to your terminal.

When the npm release is available, install it with `npm install --global @seridian-dev/kanban-cli` and skip the clone steps.

## First use

```sh
kanban auth whoami
kanban projects list
kanban agent-help
```

The CLI defaults to `https://kanban.seridian.dev`. To use another Kanban website, set `KANBAN_URL` to that website address. `KANBAN_PROJECT` and `KANBAN_USER` are optional defaults.

Sign out on this computer with `kanban logout`. This removes its saved session; the short-lived session expires automatically.

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

1. Run `kanban agent-help` for the short workflow.
2. Find a small assigned card with `items list` and `--limit`.
3. Read the card with `items get` before editing it.
4. Move it into progress and leave a short comment as work proceeds.
5. Ask before deleting work. `items rm` requires `--yes` and deletes the card and its children.
