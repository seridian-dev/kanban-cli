export const AGENT_HELP = `KANBAN CLI — agent quickstart (token-efficient)

SETUP  KANBAN_URL=https://kanban.seridian.dev  KANBAN_USER=<agent name>  KANBAN_PROJECT=KAN
AUTH   kanban login  → browser sign-in  ·  kanban auth whoami  ·  kanban logout

FIRST RUN  kanban login → kanban auth whoami → kanban projects list
WORK CARD kanban items list --project KAN --assignee "$KANBAN_USER" --status todo --limit 10 --compact --json
INSPECT   kanban items get KAN-12 --json (read parent, dependencies, and comments before editing)
START     kanban items move KAN-12 --status in_progress
UPDATE    kanban comment add KAN-12 --body "Progress: ...; next: ...; blocker: none"
QA        kanban items move KAN-12 --status in_review
FINISH    kanban items move KAN-12 --status done (only after verifying the work)

Use --project KEY or set KANBAN_PROJECT. Writes are validated by the server.
Use --compact --limit N --json to keep large boards out of the context window.
No Convex URL is needed. Login opens Kanban in your browser and asks you to approve this device.
Run 'kanban help' for the full reference. Never use --yes to delete unless requested.
`;

export const FULL_HELP = `kanban — CLI for project work. Add --json for machine-readable output.

GET STARTED
  kanban login                              sign in safely in your browser
  kanban auth whoami                        check the account linked to this device
  kanban projects list                      choose a project
  kanban agent-help                         get the coding-agent workflow
  No Convex URL is needed; Kanban discovers the backend from its website.

SETUP   export KANBAN_URL=https://kanban.seridian.dev  KANBAN_USER=<your agent name>  [KANBAN_PROJECT=KEY]
AUTH    login opens a browser approval flow; logout clears the device session.
EXIT    0 ok · 1 server/runtime error · 2 usage error · 3 not found
KEYS    Items are addressed by key (KAN-12). Statuses: backlog todo in_progress in_review done.
        Types: epic story task bug subtask. Priorities: urgent high medium low none.
HIERARCHY  epic > story|task|bug > subtask. Server rejects invalid parents/cycles (exit 1).

READ
  kanban tree KAN                               indented hierarchy of a project
  kanban items list --project KAN [--status S --assignee A --type T --epic KAN-1 --q text --limit N --compact]
  kanban items get KAN-12                       breadcrumb, children, dependencies, comments
  kanban changelog KAN [--write CHANGELOG.md]    markdown of done work, grouped by day and epic
  kanban projects list · sprints list --project KAN · comment list KAN-12

WRITE
  kanban projects create --key KAN --name "Name" [--description ..]
  kanban items create --project KAN --type story --title "..." [--parent KAN-1 --status --priority --assignee --points N --start YYYY-MM-DD --due YYYY-MM-DD --labels a,b --sprint NAME --description ..]
  kanban items update KAN-12 [--title --description --type --status --priority --assignee --points --start --due --labels --parent KAN-1 --depends-on KAN-3,KAN-4 --sprint NAME]
        "none" clears assignee/points/start/due/parent/depends-on/sprint.
  kanban items move KAN-12 --status in_progress [--after KAN-5 --before KAN-6]
  kanban items breakdown KAN-12 --text "a @sam\\nb"   (or pipe lines on stdin; epic→stories, others→subtasks)
  kanban items distribute KAN-12 --people sam,alex   (balances unassigned children by open load)
  kanban items bulk --ids KAN-1,KAN-2 [--status --assignee --priority --sprint NAME]
  kanban items rm KAN-12 --yes                      deletes the whole subtree; --yes is mandatory
  kanban comment add KAN-12 --body "..."
  kanban git connect --project KAN --provider github --repo owner/name
  kanban git status --project KAN · git links KAN-12 · git branch KAN-12
  kanban git prs --project KAN                     open PR/MR links grouped by card
  kanban git rotate-secret --project KAN --connection ID
  kanban sprints create --project KAN --name S1 [--goal .. --start .. --end ..] · sprints start|complete NAME --project KAN

SAFE USE  Run 'tree' or 'items get' before restructuring. Prefer update --parent over delete+create.
          Re-parenting keeps history; deleting does not. Never pass --yes unless the user asked to delete.
AGENT COST  --limit N caps list results; --compact returns key/type/status/title and only non-empty metadata.
            Combine both with --json for low-token work discovery.
`;
