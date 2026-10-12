# Instructions for coding agents

When this checkout is being used to change the Kanban CLI itself, follow the repository's normal development instructions and avoid overwriting unrelated working-tree changes.

When using Kanban to coordinate work in another repository, first read [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md). Use the `kanban` CLI to find and update work items; do not guess project keys or silently change card ownership/status. `kanban agent-help` is the short built-in reference and `docs/CLI.md` is the full command reference.

## Regression testing

Every change should leave this codebase harder to break and easier to change. These rules are written so a newer developer or a smaller AI model can follow them without guessing.

### When a test is required

| Change | What to add |
|---|---|
| **Bug fix** | First, a test that reproduces the bug and fails. Name it `@regression <CARD-KEY> <symptom>`, e.g. `@regression KAN-236 done column renders every card`. Then fix it. Never delete or weaken a regression test later. |
| **New feature** | Tests for the main path, the main failure or permission path, and each acceptance item on the card. One end-to-end `@smoke` test if users see the flow. |
| **Changing existing behaviour** | Update the affected tests in the same change and say why in the PR. A test edited only so it passes is a red flag for review. |
| **Refactor** | No test changes. Every existing test must pass unchanged. |
| **Schema or data change** | A test that existing data still validates, and that any migration can run twice safely. |
| **Auth, permissions, money, email, secrets** | Always a regression test for the rule itself, e.g. "a non-member cannot read", "tests never send real email", "a token is never returned twice". |

### How to write them

- **Red first.** Run the new test and watch it fail for the right reason before you write the fix.
- **Test behaviour, not internals.** Call the public function, route or screen. No snapshot-only tests for logic.
- **Deterministic.** Fake clock, fake network, fake email and payment providers. No real external services, no `sleep`, no reliance on test order. Give slow tests an explicit timeout instead of relying on the default.
- **Readable failures.** The test name says what it protects; the assertion message tells a beginner what broke.
- **Never** skip, delete, `.only`, loosen an assertion, or raise a timeout to hide a race, and never commit with `--no-verify`.
- **A flaky test is a bug.** Fix it, or quarantine it with a card and an owner. Do not ignore it.

### Before you open a PR

1. Run the full suite and the regression subset (commands below).
2. In the PR's **Test plan**, list each new regression test by name and paste the red-first run.

### Commands

Prerequisite: Node 22 or newer, then `npm ci`. No git hooks are configured in this repo.

```sh
# Full suite: build, node --test on the 12 listed test files, agent-help smoke check
npm test

# Regression subset: tests whose name contains @regression (tests compile to dist/*.test.js)
npm run build && node --test --test-name-pattern=@regression dist/*.test.js
```

Test locations: `src/*.test.ts` (compiled to `dist/*.test.js`). The runner is `node:test`, not vitest. A new test file must also be added to the file list in the `test` script in `package.json`, or the full suite will not run it.

Known issue: under `--test-name-pattern`, the `before` hooks in `src/folders.test.ts` and `src/projects.test.ts` fail (`hookFailed`), so the regression command exits non-zero until those hooks are fixed. Fix that before relying on the subset.
