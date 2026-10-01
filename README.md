# @seridian-dev/kanban-cli

The official command line interface for Kanban. Inspect work with compact JSON, update tasks, manage sprints, and connect Git activity to work items.

The CLI signs in through Kanban in your browser. It discovers the backend from the product URL, so you never need to copy a Convex URL.

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
export KANBAN_URL=https://kanban.seridian.dev
export KANBAN_PROJECT=KAN
kanban login
kanban auth whoami
kanban agent-help
kanban items list --status in_progress --limit 15 --compact --json
kanban items get KAN-12 --json
kanban comment add KAN-12 --body "Progress: ..."
```

`KANBAN_USER` optionally sets the activity label shown on updates. Authentication comes from `kanban login`; use `kanban logout` to clear this device. See [CLI documentation](docs/CLI.md) for safe environment setup and the complete command reference.

## Requirements

- Node.js 22 or newer
- A Kanban account and browser

## Development

```sh
npm install
npm run build
npm test
```

The package is also tested with Bun during development.
