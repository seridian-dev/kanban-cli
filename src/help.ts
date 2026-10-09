export const AGENT_HELP = `KANBAN CLI — agent quickstart (token-efficient)

SETUP  kanban login  (site defaults to https://kanban.seridian.dev)
AUTH   kanban login  → browser sign-in  ·  kanban auth whoami  ·  kanban logout
LOCAL  kanban link --workspace acme --project WEB  → remember this repo  ·  kanban context

FIRST RUN  kanban login → kanban auth whoami → kanban projects list → kanban link --project KEY
WORK CARD kanban items list --project WEB --assignee "$KANBAN_USER" --status todo --limit 10 --compact --json
NEXT      kanban next --json (card to work on: priority, deps done, sprint, your work) · kanban plan --json (sprint status)
INSPECT   kanban items get WEB-12 --json (read parent, dependencies, and comments before editing)
START     kanban items move WEB-12 --status in_progress
UPDATE    kanban comment add WEB-12 --body "Progress: ...; next: ...; blocker: none"
QA        kanban items move WEB-12 --status in_review
FINISH    kanban items move WEB-12 --status done (only after verifying the work)
GITHUB    kanban gh sync --dry-run → kanban gh sync (issues mirror cards; Kanban wins) · kanban gh pr (open PR, card → review)

Project lookup: --project > KANBAN_PROJECT > nearest linked folder > saved default > account CLI default.
Workspace lookup: --workspace > KANBAN_WORKSPACE > nearest linked folder > saved default > account CLI default.
Use 'kanban defaults' to show effective defaults and their source; set account defaults in Kanban → Settings → CLI defaults.
The CLI checks npm for updates at most daily; run 'kanban update check' to check now or set KANBAN_NO_UPDATE_CHECK=1 to disable.
Use 'kanban config' for saved site/user/workspace/project settings and 'kanban links list' for links.
Writes are validated by the server. Local settings live in ~/.config/kanban/config.json.
Use --compact --limit N --json to keep large boards out of the context window.
Login opens Kanban in your browser and asks you to approve this device.
Run 'kanban help' for the full reference. Never use --yes to delete unless requested.
SCHEMA   kanban schema → JSON of every command, flag, type, enum, and destructive action. Use it instead of parsing help.
`;

export const FULL_HELP = `kanban — CLI for project work. Add --json for machine-readable output.

GET STARTED
  kanban login                              sign in safely in your browser
  kanban auth whoami                        check the account linked to this device
  kanban projects list                      choose a project
  kanban link --workspace acme --project WEB  link this Git repo to a workspace project
  kanban link --project KEY --path ./docs   link a folder to a project
  kanban context                            show which project this folder uses
  kanban defaults                           show effective workspace and project defaults and their source
  kanban update check                       check for a newer CLI version now
  kanban projects open WEB                  open the selected workspace project
  kanban links list                         list saved folder links
  kanban hooks install                      install local pre-commit and pre-push checks
  kanban hooks set-item WEB-12              set this repository's active work item
  kanban hooks doctor                       inspect hook and active-item setup
  kanban config                             show saved site, user, and default project
  kanban agent-help                         get the coding-agent workflow
  kanban schema [COMMAND WORDS]             JSON schema of commands, flags, enums, and destructive actions
  Kanban discovers the service from its website.

SETUP   settings are saved in ~/.config/kanban/config.json; env vars override saved defaults
AUTH    login opens a browser approval flow; logout clears the device session.
EXIT    0 ok · 1 server/runtime error · 2 usage error · 3 not found
KEYS    Items are addressed by key (WEB-12). Statuses: backlog todo in_progress in_review done.
        Types: epic story task bug subtask. Priorities: urgent high medium low none.
HIERARCHY  epic > story|task|bug > subtask. Server rejects invalid parents/cycles (exit 1).

READ
  kanban tree WEB                               indented hierarchy of a project
  kanban items list --project WEB [--status S --assignee A --type T --epic WEB-1 --q text --limit N --compact]
  kanban items get WEB-12                       breadcrumb, children, dependencies, comments
  kanban next [--project WEB --assignee NAME]    next card to work on: ready, highest priority, active sprint first
  kanban plan [--project WEB]                   active sprint at a glance: ready, blocked, in progress, review, done, points
  kanban changelog WEB [--write CHANGELOG.md]    markdown of done work, grouped by day and epic
  kanban projects list · kanban sprints list --project WEB · kanban comment list WEB-12

WRITE
  kanban projects create --key WEB --name "Name" [--description ..]
  kanban items create --project WEB --type story --title "..." [--parent WEB-1 --status --priority --assignee --points N --start YYYY-MM-DD --due YYYY-MM-DD --labels a,b --sprint NAME --description ..]
  kanban items update WEB-12 [--title --description --type --status --priority --assignee --points --start --due --labels --parent WEB-1 --depends-on WEB-3,WEB-4 --sprint NAME]
        "none" clears assignee/points/start/due/parent/depends-on/sprint.
  kanban items move WEB-12 --status in_progress [--after WEB-5 --before WEB-6]
  kanban items breakdown WEB-12 --text "a @sam\\nb"   (or pipe lines on stdin; epic→stories, others→subtasks)
  kanban items distribute WEB-12 --people sam,alex   (balances unassigned children by open load)
  kanban items bulk --ids WEB-1,WEB-2 [--status --assignee --priority --sprint NAME]
  kanban items rm WEB-12 --yes                      deletes the whole subtree; --yes is mandatory
  kanban comment add WEB-12 --body "..."
  kanban hooks install · kanban hooks set-item KEY · kanban hooks doctor
  kanban git connect --project WEB --provider github --repo owner/name
  kanban git status --project WEB · kanban git links WEB-12 · kanban git branch WEB-12
  kanban git prs --project WEB                     open PR/MR links grouped by card
  kanban git rotate-secret --project WEB --connection ID
  kanban gh sync --project WEB [--repo owner/name --dry-run --include-done --no-comments --relink --board-url URL]
        two-way GitHub issue sync via the gh CLI; Kanban is ground truth. --repo defaults to the repo saved by
        kanban link (auto-detected from origin), so linked checkouts just run: kanban gh sync
        kanban link --project WEB --board-url URL saves the board link used in issue bodies.
        PRs that name a card (title, branch, body, or "Closes #n") are listed on its issue; an open PR moves
        the card to in_review once (--no-prs to skip). Nothing is ever moved to done automatically.
  kanban gh pr [WEB-12] [--draft --base main --title .. --body ..]   open a PR for this branch: "WEB-12: title",
        Closes #issue, acceptance criteria; key from the arg, the active item, or the branch name
  kanban gh issue [WEB-12]                         print the GitHub issue URL for a card
  kanban sprints create --project WEB --name S1 [--goal .. --start .. --end ..] · kanban sprints start|complete NAME --project WEB
  kanban config set site https://kanban.seridian.dev · kanban config set user alex · kanban config set workspace acme · kanban config set project WEB
  kanban links remove [--path .]

SAFE USE  Run 'tree' or 'items get' before restructuring. Prefer update --parent over delete+create.
          Re-parenting keeps history; deleting does not. Never pass --yes unless the user asked to delete.
AGENT COST  --limit N caps list results; --compact returns key/type/status/title and only non-empty metadata.
            Combine both with --json for low-token work discovery.
`;
