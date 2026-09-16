# Build reports

A record of how each ticket was built, saved by the orchestrator from the implementing agent's
final report at the moment the work was handed over. Read the report for any ticket you build on;
`AGENTS.md` says so, and this file is the index.

## A report is not an ADR

An ADR under `docs/adr/` records a **decision**: what was chosen, what it was chosen over, and why.
It is written to stay true, and it is amended when the decision changes.

A report under `docs/reports/` records **how one ticket was built**: what landed and where, which
contracts the next tickets must match, what was verified by hand and what was deliberately not,
the deviations from the ticket and their reasons, and what was left for the next person. It is a
snapshot with a date on it — "CI green, awaiting review" describes the day it was written, not
today — so where a report and the code disagree, the code has moved on and the report tells you
what it moved on *from*. Nothing in a report is a decision: a report that says "we chose X" is
citing an ADR or recording a local choice the ticket made within one, and the argument lives in
the ADR.

The reports are kept as they were written, verbatim apart from the scrub described below. They
are records, not prose to be improved.

## Naming

- `gra-<N>-report.md` — the final report for ticket GRA-N.
- `gra-<N>-interface.md` — an interim report pushed part-way through GRA-N, recording the
  interface other tickets were told to build against. Superseded by the ticket's final report and
  kept because those other tickets were built against it.
- `gra-<N>-<qualifier>-report.md` — a follow-up on the same ticket (`gra-41-override-report.md`).
- `design-alignment-*.md` — the two read-only surveys ADR 0017's work was planned from.
- `*-inventory.md` — the two copy inventories ADR 0011's work was planned from.

Two reports (GRA-6, GRA-18) were saved as PR bodies beginning `Closes GRA-…`; each was given the
same first-line heading the others carry, and nothing else changed.

## What was scrubbed

This repository is written to become public, so before the reports were committed every local
filesystem path was replaced with a repo-relative path or a phrase ("the Graft checkout", "the
orchestrator's temp directory"), and every reference to a screenshot now points at graft-cloud's
`docs/screens/gra-<N>/`, where the PNGs live. Nothing load-bearing was cut, so there is no
unscrubbed original anywhere else: what is here is the whole report.

Four reports are not here. Their subject is the hosted form or its infrastructure — the private
backings, the Pulumi projects, the first deploy — and they carry the account ids, ARNs and
workspace names that make them meaningful, so they live in graft-cloud's `docs/reports/` instead:
GRA-20 (open PR #11 + graft-cloud #1), GRA-34 (graft-cloud #2, plus the orchestrator's running log
of the first deploy), GRA-38 (open PR #20 + graft-cloud #3) and GRA-39 (open PR #21 + graft-cloud
#4).

## Index

Generated from each file's first lines. A PR number without a prefix is this repository's;
`graft-docs #N` is a pull request in the documentation site's repository.

| Ticket | File | Title | PRs | Date |
|---|---|---|---|---|
| GRA-3 | `gra-3-report.md` | check + runner | #4 | 2026-09-09 |
| GRA-4 | `gra-4-report.md` | sandbox seam, Docker backing, conformance suite | #5 | 2026-09-09 |
| GRA-5 | `gra-5-report.md` | the proxy reaches a vendor through a host segment, with the placeholder credential stripped | #6 | 2026-09-09 |
| GRA-6 | `gra-6-report.md` | persons, agents, connections and the toolbox rows exist, with services | #7 | 2026-09-09 |
| GRA-18 | `gra-18-report.md` | publish writes a version and vendors its packages under the policy | #8 | 2026-09-09 |
| GRA-19 | `gra-19-report.md` | MCP server | #9 | 2026-09-09 |
| GRA-23 | `gra-23-report.md` | reads pass, writes ask once, destructive asks every time | #12 | 2026-09-09 |
| GRA-24 | `gra-24-report.md` | the working set contracts by cap and idle window | #10 | 2026-09-09 |
| GRA-25 | `gra-25-report.md` | OpenClaw spike | no PR; findings as a Linear comment | 2026-09-09 |
| GRA-28 | `gra-28-interface.md` | interface half: request_connection / request_credential | #14 (interim) | 2026-09-09 |
| GRA-28 | `gra-28-report.md` | the agent proposes a connection and the person enters the secret | #14 | 2026-09-09 |
| GRA-29 | `gra-29-interface.md` | interface half: acquire | #16 (interim) | 2026-09-09 |
| GRA-29 | `gra-29-report.md` | `acquire` builds a tool with a scripted model | #16 | 2026-09-09 |
| GRA-30 | `gra-30-report.md` | authorization-code OAuth, guided | #18 | 2026-09-09 |
| GRA-31 | `gra-31-report.md` | a real model authors, the evals score it, the Hermes skill points at it | #19 | 2026-09-09 |
| GRA-33 | `gra-33-interface.md` | interface half: one image and a compose file | #17 (interim) | 2026-09-09 |
| GRA-33 | `gra-33-report.md` | one Docker image and a compose file run the whole loop | #17 | 2026-09-09 |
| GRA-41 | `gra-41-override-report.md` | follow-up: the esbuild override lives in pnpm-workspace.yaml | #24 | 2026-09-11 |
| GRA-42 | `gra-42-report.md` | an elicitation accept without `allow` is an allow, for Hermes' approval buttons | #23 | 2026-09-11 |
| GRA-44 | `gra-44-report.md` | the console takes Cando's tokens, type stacks, icons and theme, with the guards | #25 | 2026-09-11 |
| GRA-45 | `gra-45-report.md` | Cando's primitives replace the console's; selects, confirmations and code blocks become primitives | #26 | 2026-09-11 |
| GRA-46 | `gra-46-report.md` | the console wears Cando's shell, page frame and auth doors | #28 | 2026-09-11 |
| GRA-47 | `gra-47-report.md` | screens follow Cando's patterns | #30 | 2026-09-11 |
| GRA-48 | `gra-48-report.md` | the OAuth callback page is drawn by the console | #29 | 2026-09-11 |
| GRA-49 | `gra-49-report.md` | GT Standard L and GT Standard Mono ship with the console | #27 | 2026-09-11 |
| GRA-52 | `gra-52-report.md` | destructive tools ask once; asking every time is an opt-in | #31, graft-docs #4 | 2026-09-15 |
| GRA-53 | `gra-53-report.md` | MCP clients connect over OAuth; the consent mints the agent | #33, graft-docs #6 | 2026-09-15 |
| GRA-54 | `gra-54-report.md` | the MCP handshake carries the playbook | #32, graft-docs #5 | 2026-09-15 |
| GRA-55 | `gra-55-report.md` | a cancelled elicitation falls back to the handoff | #34, graft-docs #7 | 2026-09-16 |
| — | `design-alignment-cando-design-system-survey.md` | Survey: the Cando design system as expressed in code | — | 2026-09-11 |
| — | `design-alignment-graft-console-survey.md` | Survey: the Graft console before the Cando design-system alignment | — | 2026-09-11 |
| — | `cando-inventory.md` | Cando → Graft copy inventory | — | 2026-09-09 |
| — | `modern-inventory.md` | Modern inventory for Graft (GRA-5, GRA-3) | — | 2026-09-09 |
