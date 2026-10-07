# Kanban CLI guide

Use this guide to work with Kanban from a terminal or coding agent. The CLI signs in through your browser and connects through `kanban.seridian.dev`.

## Install

Install the published package with npm:

```sh
npm install -g @seridian/kanban-cli
kanban login
kanban agent-help
```

Your browser opens. Sign in to Kanban and choose **Authorize CLI**. After approval, return to your terminal. The CLI token is saved under `~/.config/kanban/auth.json` with owner-only file and directory permissions. It expires after three days; run `kanban login` again to reconnect. `kanban logout` removes the token from this computer.

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

Project selection is resolved in this order: `--project`, `KANBAN_PROJECT`, the nearest linked folder, the saved default project, then the account's CLI default in Kanban settings. Workspace selection follows the same order with `--workspace`, `KANBAN_WORKSPACE`, folder link, saved default, and account default. Account defaults are fetched only when no local value is available. Run `kanban defaults` to see each effective value and its source; set account values in **Kanban → Settings → CLI defaults**.

The CLI checks npm for a newer version at most once every 24 hours and shows an update notice after a command completes. It stores the check in `~/.config/kanban/update-check.json`. The check never blocks or fails a command. Run `kanban update check` to force a check and show the result. Set `KANBAN_NO_UPDATE_CHECK=1` to disable automatic checks; checks are also disabled in CI and for `agent-help`.

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
kanban gh sync --project WEB --dry-run
kanban agent-help
```

The full help text is available with `kanban help`. The server checks hierarchy, dependencies, project membership, and other write rules. Exit codes are `0` success, `1` server/runtime error, `2` invalid command, and `3` not found.

## Agent safety

1. Run `kanban agent-help` for the short workflow.
2. Find a small assigned card with `items list` and `--limit`.
3. Read the card with `items get` before editing it.
4. Move it into progress and leave a short comment as work proceeds.
5. Ask before deleting work. `items rm` requires `--yes` and deletes the card and its children.

## GitHub issue sync

`kanban gh sync` mirrors a project to GitHub issues through the `gh` CLI (`gh auth login` first). Kanban is the ground truth:

- **Kanban → GitHub:** one issue per open card, titled `[KEY] title`. Each issue gets labels (`type:`, `priority:`, `status:`, `area:`), the sprint as a milestone, acceptance criteria as a checklist, and native sub-issues and blocked-by links. Titles, bodies, labels, milestones, and open/closed state are overwritten from Kanban on every run. Done cards close their issue.
- **GitHub → Kanban:** open issues without a Kanban key become backlog cards (`bug` if labelled bug), and the issue is stamped with the new key. GitHub comments are copied to the card, and card comments are copied to the issue, each only once. An issue closed on GitHub, for example by a merged PR, moves its card to `in_review` for a person to confirm; it is never reopened.
- **Repo:** `--repo owner/name`, else the repo saved by `kanban link` (detected from the `origin` remote), else `origin`. Upstream remotes are never used.
- **Flags:** `--dry-run` prints the plan. `--include-done` also mirrors done cards. `--no-comments` skips comment sync. `--relink` re-applies sub-issue and dependency links. `--board-url` adds a board link to each issue; save it once with `kanban link --project KEY --board-url URL`. Label an issue `kanban-ignore` to keep it out of Kanban.

Each issue body ends with a hidden `<!-- kanban:KEY -->` marker, so no local state is needed and any machine can run the sync.

## Git hooks

From the repository where you want local checks, link it to a Kanban project, set the active card, then install the hooks:

```sh
kanban link --project WEB
kanban hooks set-item WEB-12
kanban hooks install
kanban hooks doctor
```

The pre-commit check requires the active item to belong to the selected project and be `in_progress` or `in_review`. The pre-push check requires every outgoing commit to reference an item in that project; each item must exist and be `in_progress`, `in_review`, or `done`. Checks need a working CLI login and Kanban connection; missing context, an offline server, or a stale item blocks the Git operation with an error. Set a new active item with `kanban hooks set-item KEY` when switching work. The installer respects `core.hooksPath`, leaves existing hooks and Git config untouched, and asks you to chain the Kanban check manually. These are local workflow checks and can be bypassed; require CI status checks and branch protection when enforcement must be reliable.
