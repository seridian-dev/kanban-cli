# Kanban CLI guide

Use this guide to work with Kanban from a terminal or coding agent. The CLI signs in through your browser and connects through `kanban.seridian.dev`.

## Install

Install the published package with npm:

```sh
npm install -g @seridian/kanban-cli
kanban login
kanban agent-help
```

Your browser opens. Sign in to Kanban and choose **Authorize CLI**. After approval, return to your terminal.

## First use

```sh
kanban auth whoami
kanban projects list
kanban agent-help
```

The CLI connects to `https://kanban.seridian.dev` by default, so you do not need to set `KANBAN_URL`. To use another Kanban website, set `KANBAN_URL` to that website address. `KANBAN_PROJECT` and `KANBAN_USER` are optional defaults. You can save those defaults locally:

```sh
kanban config set site https://kanban.seridian.dev
kanban config set user alex
kanban config set workspace acme
kanban config set project WEB
kanban config
```

The config file is `~/.config/kanban/config.json`, with owner-only permissions. It contains no credentials; login tokens remain in a separate protected file.

Link a Git repo to a project once. From the repo root, run `kanban link --workspace acme --project WEB`. You can link a specific folder with `kanban link --workspace acme --project WEB --path ./packages/api`. Run `kanban context` in a nested folder to check the selected workspace and project. The nearest folder link wins, so a subfolder can point to a different workspace project. Use `kanban links list` to review mappings and `kanban links remove --path ./packages/api` to remove one. `kanban projects open WEB` opens that project in the browser.

Project selection is resolved in this order: `--project`, `KANBAN_PROJECT`, the nearest linked folder, then the saved default project. These are local settings; your repository stays untouched.

Sign out on this computer with `kanban logout`. This removes its saved session; the short-lived session expires automatically.

## Everyday work

```sh
kanban items list --status in_progress --limit 15 --compact --json
kanban items get WEB-12 --json
kanban items move WEB-12 --status in_progress
kanban comment add WEB-12 --body "Progress: implementation started"
kanban changelog WEB
```

`KANBAN_PROJECT` supplies the default project key. Pass `--project KEY` when working across projects. Add `--json` for machine output, and combine `--compact` with `--limit` to keep output small.

## Common commands

```text
kanban projects list
kanban tree WEB
kanban items list --project WEB [--status S --assignee A --type T --epic WEB-1 --q text --limit N --compact]
kanban items get WEB-12
kanban items create --project WEB --type story --title "..."
kanban items update WEB-12 --status in_review
kanban items move WEB-12 --status in_progress
kanban items breakdown WEB-12 --text "Validate API @sam\nAdd review screen @alex"
kanban sprints list --project WEB
kanban comment add WEB-12 --body "..."
kanban changelog WEB [--write CHANGELOG.md]
kanban git status --project WEB
kanban agent-help
```

The full help text is available with `kanban help`. The server checks hierarchy, dependencies, project membership, and other write rules. Exit codes are `0` success, `1` server/runtime error, `2` invalid command, and `3` not found.

## Agent safety

1. Run `kanban agent-help` for the short workflow.
2. Find a small assigned card with `items list` and `--limit`.
3. Read the card with `items get` before editing it.
4. Move it into progress and leave a short comment as work proceeds.
5. Ask before deleting work. `items rm` requires `--yes` and deletes the card and its children.
