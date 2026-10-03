# Instructions for coding agents

When this checkout is being used to change the Kanban CLI itself, follow the repository's normal development instructions and avoid overwriting unrelated working-tree changes.

When using Kanban to coordinate work in another repository, first read [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md). Use the `kanban` CLI to find and update work items; do not guess project keys or silently change card ownership/status. `kanban agent-help` is the short built-in reference and `docs/CLI.md` is the full command reference.
