# Changelog

## Unreleased

- The CLI now updates itself. Once per day it checks npm (2-second timeout, cached in `~/.config/kanban/update-check.json`); when a newer version is published and the CLI is installed globally, it installs the release and re-runs the original command with the new version. The check is skipped for `CI=true`, `KANBAN_NO_UPDATE=1`, `--json` without a terminal, and npx runs; any failure prints one hint and the command continues.
- Cards in the Shadow Realm can no longer be destroyed. `kanban items rm KEY --purge` now exits 2 with "Cards in the Shadow Realm can't be destroyed. Use `kanban items restore KEY` to bring one back." and sends nothing, with or without `--yes` or `--dry-run`. The purge path and its `workItems.destroyForever` call were removed from the CLI.
- `kanban schema` no longer marks `--purge` as destructive; it is listed as refused.

## 0.3.2

- Fix: regenerate package-lock.json with npm 11 (the version the publish runner uses) so `npm ci` includes every platform's esbuild package. 0.3.0 and 0.3.1 could not publish.

## 0.3.1

- Fix: refresh package-lock.json so the npm trusted-publishing workflow can install (0.3.0's tag could not publish).

## 0.3.0

- `kanban items rm KEY --yes` now banishes the card and its subtree to the Shadow Realm instead of deleting it. The output names the restore command. Older CLI versions still call `workItems.remove`, which the server now banishes instead of deleting.
- New `kanban items restore KEY` summons a banished card back, with the cards banished along with it.
- New `kanban items rm KEY --purge --yes` destroys a banished card forever. It needs `--yes`, and the card must already be banished. Only workspace owners and admins can destroy; other roles get the server's message plus a hint.
- New `kanban shadow-realm list [--workspace SLUG] [--project KEY] [--json]` lists banished cards with who banished them and when.
- `items restore` and `items rm --purge` accept `--dry-run`; both print what would change and send nothing.
- `kanban schema` marks `items rm --purge` as destructive. `kanban --help`, `agent-help`, the CLI guide and the README describe the Shadow Realm.
