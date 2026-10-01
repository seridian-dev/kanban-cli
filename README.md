# Kanban CLI

Use Kanban from your terminal, or let your coding agent read and update work for you.

**You only need a Kanban account.** The CLI connects through `kanban.seridian.dev` and signs in with your browser.

## Get started

You need [Node.js 22 or newer](https://nodejs.org/) and a Kanban account.

The npm release is not available yet. Install today from this public repository:

```sh
git clone https://github.com/seridian-dev/kanban-cli.git
cd kanban-cli
npm install
npm link
kanban login
```

Your browser opens. Sign in to Kanban and select **Authorize CLI**. Return to your terminal when it says you’re signed in.

## Try it

```sh
kanban auth whoami
kanban projects list
kanban items list --project KAN --limit 10
kanban items get KAN-12
```

Replace `KAN` and `KAN-12` with your project and item keys. To see the short guide for coding agents, run:

```sh
kanban agent-help
```

It explains how to find a card, read its dependencies, start work, leave a progress note, and send the card to review.

Save your name and default project with `kanban config set user dee` and `kanban config set project KAN`. From a repo, `kanban link --project KAN` remembers which project it belongs to. Run `kanban context` in any folder to check the selected project. These settings stay in `~/.config/kanban/config.json`; the CLI does not modify your repository.

## Sign out

```sh
kanban logout
```

This removes the saved session from this computer. The short-lived session expires automatically.

## For coding agents

Give your agent this starting point:

```text
Use the Kanban CLI. First run `kanban agent-help`, then find your assigned card
with `kanban items list --project <KEY> --assignee <YOUR NAME> --limit 10 --json`.
Read the card before editing it. Keep updates small and leave a progress comment.
```

All commands are listed in the [CLI guide](docs/CLI.md). The source repository is [seridian-dev/kanban-cli](https://github.com/seridian-dev/kanban-cli).

## Install from npm later

Once the npm release is available, install it with:

```sh
npm install --global @seridian-dev/kanban-cli
kanban login
```

## Develop the CLI

```sh
npm install
npm test
```
