# @seridian-dev/kanban-cli

The official command line interface for Kanban. Inspect work with compact JSON, update tasks, manage sprints, and connect Git activity to work items.

> **Preview:** Current CLI authentication is being upgraded to secure, revocable, workspace-scoped credentials. Until that work ships, use this preview only with local or development data. Never point it at production or send it customer data.

## Install

The package is prepared for the public npm scope; registry publication is pending npm organization access. The source repository is public now. To install and build the current Node.js preview:

```sh
git clone https://github.com/seridian-dev/kanban-cli.git
cd kanban-cli
npm install
npm run build
node dist/kanban.js agent-help
```

After `@seridian-dev/kanban-cli` is published, install it globally with:

```sh
npm install --global @seridian-dev/kanban-cli
kanban agent-help
```

## Configure

```sh
export KANBAN_URL=https://<development-deployment>.convex.cloud
export KANBAN_PROJECT=KAN
export KANBAN_USER="your name or agent label"
kanban agent-help
kanban items list --status in_progress --limit 15 --compact --json
kanban items get KAN-12 --json
kanban comment add KAN-12 --body "Progress: ..."
```

`KANBAN_USER` is an activity label, not an authentication credential. See [CLI documentation](docs/CLI.md) for safe environment setup and the complete command reference.

## Requirements

- Node.js 22 or newer
- A Kanban Convex deployment URL

## Development

```sh
npm install
npm run build
npm test
```

The package is also tested with Bun during development.
