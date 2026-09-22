# Issue tracker: Linear

Issues and specs for this repository live in **Linear**, in the **Graft** team (identifiers
`GRA-<n>`). Not GitHub Issues: the GitHub remote hosts code and pull requests only, and Linear is
private, so a ticket identifier in this repository is a name rather than a link an outside reader
can open (`CONTRIBUTING.md`, *Tickets, reports and review*).

Use the **Linear MCP server**. It is configured in the person's own Claude Code or Codex
configuration, not in this repository, because an outside contributor has no access to it. There
is no `linear` CLI here; do not reach for `gh issue`, which is the default assumption of several
vendored skills and is wrong for this repository.

The word *agent* in this directory means the coding agent reading these files. In the rest of the
repository it is Graft's own term, defined in `CONTEXT.md`.

## Conventions

- **Create an issue**: `save_issue` with `team: "Graft"` and no `id`. `title` and `team` are
  required. Body goes in `description` as Markdown; send literal newlines, not `\n` escapes.
- **Update an issue**: `save_issue` with `id` set to the identifier (e.g. `GRA-179`). To change
  part of a long description without resending all of it, pass `patch` instead of `description`.
- **Read an issue**: `get_issue`. Comments come from `list_comments`.
- **List issues**: `list_issues`, filtered by `team`, `project`, `label`, `state` or `assignee`.
- **Comment**: `save_comment`.
- **Labels**: `list_issue_labels` to see what exists, `save_issue_label` to add one. `save_issue`'s
  `labels` array replaces the set wholesale; `addLabels` and `removeLabels` change it
  incrementally, and omitting all three leaves it untouched.
- **Close**: `save_issue` with `state` set to a state name or type.

Every issue belongs to the Graft team. The team id is stable but the name resolves fine, so pass
`"Graft"` rather than hardcoding a UUID.

## How work is grouped

Linear nests **initiative → project → issue**. An issue cannot attach to an initiative directly, so
grouping a body of work means putting it in a project and putting that project in an initiative.

- **Initiative**: the delivery container, *Graft*. Create another with `save_initiative`.
- **Project**: one body of work inside it. *Graft launch: the loop end to end* is where the work
  towards the launch goes, *Graft roadmap* holds what `docs/roadmap.md` says is deliberately later,
  and a spec with several tickets gets a project of its own (*Chat products as clients*, *Console:
  Cando design system*, *Connection providers*, *Observability* are the shape). Create with
  `save_project`, which needs `addTeams` and takes `addInitiatives`.
- **Issue**: set `project` on `save_issue`.

When `/to-tickets` breaks a spec into tickets, put every ticket in the **same project as the spec**
so the whole tree stays together.

Creating a project or initiative through the MCP server does **not** create a Slack channel; that
is a Linear UI-side option and is unavailable here.

## Relationships

Linear has natives for both relationships the skills need, and they mean different things. Use
both rather than collapsing them into one.

- **Parent / sub-issue**: `parentId` on `save_issue`. Use this for a spec and the tickets derived
  from it, so the tickets nest under the spec and show progress against it.
- **Blocking**: `blockedBy` and `blocks` on `save_issue`, taking identifiers. Use this for
  dependency edges. Both are **append-only**; remove with `removeBlockedBy` / `removeBlocks`.

Because blocking edges reference real identifiers, **publish tickets in dependency order**,
blockers first, so each ticket can point at an issue that already exists.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Leave this off. It is not a stylistic preference: `/triage` step 3 verifies a PR by checking it
out and running its tests, which for a PR from outside the organisation means executing
contributor-controlled code in a session holding AWS credentials, the hosted form's secrets and a
GitHub token. This repository is public under Apache-2.0 (ADR 0022) and takes outside
contributions, so the risk is real here, not theoretical as it was in Cando (Greptile raised it on
CAN-26), and this flag is what stands in the way. Triage an outside pull request by reading it.

This cannot be fixed by editing `triage/SKILL.md`; that file is vendored and any edit is lost on
the next sync.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the Graft team. Put it in the relevant project. If it came from a spec,
set `parentId` to the spec.

## When a skill says "fetch the relevant ticket"

`get_issue` with the identifier, plus `list_comments` for the discussion. Then read the pull
request body of any ticket it builds on: `docs/reports/README.md` indexes them, and the body is
the build record (`AGENTS.md`, *Before anything else*).

## Pull requests

Separate from issues, and on GitHub. **Every pull request has a Linear ticket**: open the ticket
before starting work and reference it in the PR title and body. If no ticket exists for what you
are about to do, create one rather than opening the PR without it. The body is the build record
the next ticket reads, so it says what landed, the contracts to match, what was verified by hand
and what was not, and each deviation with its reason.

`main` is protected: pushes are rejected, and a PR needs one approving review, a green
`Typecheck, Lint & Test` check, a clean Greptile review and a `Signed-off-by` line on every commit
(`git commit -s`; the `DCO` workflow checks). Branch names follow `aleks/gra-<n>-<slug>`;
`save_issue` returns a `gitBranchName` you can use directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an issue with its tickets as sub-issues.

- **Map**: an issue labelled `wayfinder:map` holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: an issue with `parentId` set to the map, labelled `wayfinder:<type>`
  (`research` / `prototype` / `grilling` / `task`). Assign it to the driving dev once claimed.
- **Blocking**: `blockedBy` with the blocker's identifier. A ticket is unblocked when every blocker
  is closed.
- **Frontier query**: `list_issues` filtered to the map's children in an open state, dropping any
  with an open blocker or an existing assignee. First in map order wins.
- **Claim**: `save_issue` with `assignee: "me"`, the session's first write.
- **Resolve**: `save_comment` with the answer, set the issue to a completed state, then append a
  context pointer to the map's Decisions-so-far.

The `wayfinder:*` labels do not exist yet; create them with `save_issue_label` on first use.
