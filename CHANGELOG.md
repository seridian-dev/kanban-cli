# Changelog

## 0.3.0

- `kanban items rm KEY --yes` now banishes the card and its subtree to the Shadow Realm instead of deleting it. The output names the restore command. Older CLI versions still call `workItems.remove`, which the server now banishes instead of deleting.
- New `kanban items restore KEY` summons a banished card back, with the cards banished along with it.
- New `kanban items rm KEY --purge --yes` destroys a banished card forever. It needs `--yes`, and the card must already be banished. Only workspace owners and admins can destroy; other roles get the server's message plus a hint.
- New `kanban shadow-realm list [--workspace SLUG] [--project KEY] [--json]` lists banished cards with who banished them and when.
- `items restore` and `items rm --purge` accept `--dry-run`; both print what would change and send nothing.
- `kanban schema` marks `items rm --purge` as destructive. `kanban --help`, `agent-help`, the CLI guide and the README describe the Shadow Realm.
