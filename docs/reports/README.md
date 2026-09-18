# Build reports: the index

**A ticket's build record is its pull request body.** It says what landed and where, the contracts
later tickets were told to match, what was verified by hand and what was deliberately not, the
deviations from the ticket and their reasons. Read it before building on the ticket. Linear holds
the ticket itself and its outcome — the acceptance criteria, the comments, the findings a spike left
when it had no pull request — and `docs/adr/` holds the decisions. A report is none of those: it is
how one ticket was built, on the day it was built, and the pull request is where that already lives.

This file is the index over those bodies, one row per ticket, so a ticket number found in a
comment or an ADR leads to its record in one step. It is a snapshot with a date on it, like the
bodies it points at; a pull request merged after it was last edited is not in it.

The orchestrator kept its own copy of each implementing agent's final report while the tickets
were being built. Measured against the bodies, those copies were mostly redundant — for every
recent ticket the pull request body was larger than the report — so they were not committed. Where
a report held something its pull request body lacked (exact type declarations, wire shapes, a
decision recorded after the body was written), that content was appended to the body on
2026-09-17 under a heading `## Build report (added 2026-09-17 from the orchestrator's record)`,
verbatim apart from local paths. Fourteen bodies carry one: graft #4, #6, #7, #8, #9, #12, #14, #16,
#17, #18, #23 and #34, and graft-cloud #1 and #5.

## Reference documents kept here

Four documents no single pull request owns, kept because the work that read them cites them:

- `design-alignment-cando-design-system-survey.md` and `design-alignment-graft-console-survey.md`
  — the two read-only surveys ADR 0017's console alignment (GRA-44 through GRA-49) was planned from,
  2026-09-11.
- `cando-inventory.md` and `modern-inventory.md` — the two copy inventories ADR 0011's port from
  Cando and Modern was planned from, 2026-09-09.

All four had their local filesystem paths replaced with repo-relative paths or a phrase before
being committed; nothing else was changed.

## Where the rest is

- The hosted form's pull requests — the private backings, the Pulumi projects, the first deploy —
  are in getmodern-ai/graft-cloud, whose `docs/reports/README.md` indexes them and whose
  `docs/screens/gra-<N>/` holds the console screenshots the design-alignment bodies cite.
- GRA-25, the OpenClaw spike, produced no pull request; its findings are a comment on the ticket.
- Pull requests [#1](https://github.com/getmodern-ai/graft/pull/1) and
  [#2](https://github.com/getmodern-ai/graft/pull/2) (2026-09-08) predate the tickets: the required
  check and Dependabot mirrored from Cando, and the decision-record check's external-citation rule.

## Index

A bare number is a pull request in this repository. Where a ticket has two, the second follows the
first in the outcome.

| Ticket | PRs | Merged | Outcome |
|---|---|---|---|
| [GRA-2](https://linear.app/get-modern/issue/GRA-2) | [#3](https://github.com/getmodern-ai/graft/pull/3) | 2026-09-09 | scaffold the workspace and give CI its typecheck, lint and test steps |
| [GRA-3](https://linear.app/get-modern/issue/GRA-3) | [#4](https://github.com/getmodern-ai/graft/pull/4) | 2026-09-09 | the check learns SDK binding and derives the annotations; the runner gains proxyBase |
| [GRA-4](https://linear.app/get-modern/issue/GRA-4) | [#5](https://github.com/getmodern-ai/graft/pull/5) | 2026-09-09 | the sandbox seam, an in-process fake, the Docker backing and a conformance suite in CI |
| [GRA-5](https://linear.app/get-modern/issue/GRA-5) | [#6](https://github.com/getmodern-ai/graft/pull/6) | 2026-09-09 | the proxy reaches a vendor through a host segment, with the placeholder credential stripped |
| [GRA-6](https://linear.app/get-modern/issue/GRA-6) | [#7](https://github.com/getmodern-ai/graft/pull/7) | 2026-09-09 | persons, agents, connections and the toolbox rows, with services that run without a database |
| [GRA-18](https://linear.app/get-modern/issue/GRA-18) | [#8](https://github.com/getmodern-ai/graft/pull/8) | 2026-09-09 | the toolbox storage seam, the package policy and a publish that vendors under it |
| [GRA-19](https://linear.app/get-modern/issue/GRA-19) | [#9](https://github.com/getmodern-ai/graft/pull/9) | 2026-09-09 | an agent connects over MCP and sees its working set |
| [GRA-20](https://linear.app/get-modern/issue/GRA-20) | [#11](https://github.com/getmodern-ai/graft/pull/11) | 2026-09-09 | the backings selector; the private package is absent by default (the backings themselves: graft-cloud #1) |
| [GRA-23](https://linear.app/get-modern/issue/GRA-23) | [#12](https://github.com/getmodern-ai/graft/pull/12) | 2026-09-09 | reads pass, writes ask once, destructive asks every time |
| [GRA-24](https://linear.app/get-modern/issue/GRA-24) | [#10](https://github.com/getmodern-ai/graft/pull/10) | 2026-09-09 | the working set contracts by cap and idle window |
| [GRA-25](https://linear.app/get-modern/issue/GRA-25) | — | — | the OpenClaw spike: go, as the second harness; findings as a comment on the ticket |
| [GRA-26](https://linear.app/get-modern/issue/GRA-26) | [#13](https://github.com/getmodern-ai/graft/pull/13) | 2026-09-09 | the console: sign in, agents, pending actions, working sets |
| [GRA-28](https://linear.app/get-modern/issue/GRA-28) | [#14](https://github.com/getmodern-ai/graft/pull/14) | 2026-09-09 | the agent proposes a connection and the person enters the secret |
| [GRA-29](https://linear.app/get-modern/issue/GRA-29) | [#16](https://github.com/getmodern-ai/graft/pull/16) | 2026-09-09 | acquire builds a tool with a scripted model |
| [GRA-30](https://linear.app/get-modern/issue/GRA-30) | [#18](https://github.com/getmodern-ai/graft/pull/18) | 2026-09-09 | authorization-code OAuth with a client the person registered, guided |
| [GRA-31](https://linear.app/get-modern/issue/GRA-31) | [#19](https://github.com/getmodern-ai/graft/pull/19) | 2026-09-09 | a real model authors, the evals score it, the Hermes skill points at it |
| [GRA-33](https://linear.app/get-modern/issue/GRA-33) | [#17](https://github.com/getmodern-ai/graft/pull/17) | 2026-09-09 | one image and a compose file run the whole loop |
| [GRA-37](https://linear.app/get-modern/issue/GRA-37) | [#15](https://github.com/getmodern-ai/graft/pull/15) | 2026-09-09 | run the workflow on every pull request, not only those against main |
| [GRA-38](https://linear.app/get-modern/issue/GRA-38) | [#20](https://github.com/getmodern-ai/graft/pull/20) | 2026-09-09 | the image carries a linked backings package the bundled server can load (the package's build: graft-cloud #3) |
| [GRA-39](https://linear.app/get-modern/issue/GRA-39) | [#21](https://github.com/getmodern-ai/graft/pull/21) | 2026-09-09 | a backing may own the toolbox store; a store conformance suite (the drive-backed store: graft-cloud #5) |
| [GRA-41](https://linear.app/get-modern/issue/GRA-41) | [#22](https://github.com/getmodern-ai/graft/pull/22), [#24](https://github.com/getmodern-ai/graft/pull/24) | 2026-09-09, 2026-09-11 | override drizzle-kit's transitive esbuild to the 0.25 line; then the override lives in pnpm-workspace.yaml, where pnpm 10 reads it |
| [GRA-42](https://linear.app/get-modern/issue/GRA-42) | [#23](https://github.com/getmodern-ai/graft/pull/23) | 2026-09-11 | an elicitation accept without allow is an allow, for Hermes' approval buttons |
| [GRA-43](https://linear.app/get-modern/issue/GRA-43) | [#67](https://github.com/getmodern-ai/graft/pull/67) | 2026-09-18 | an elicitation declined faster than a person could read it is a dismissal, and falls through to the console |
| [GRA-44](https://linear.app/get-modern/issue/GRA-44) | [#25](https://github.com/getmodern-ai/graft/pull/25) | 2026-09-11 | the console takes Cando's tokens, icons and theme, with the token guards |
| [GRA-45](https://linear.app/get-modern/issue/GRA-45) | [#26](https://github.com/getmodern-ai/graft/pull/26) | 2026-09-11 | Cando's primitives replace the console's; selects, confirmations and code blocks become primitives |
| [GRA-46](https://linear.app/get-modern/issue/GRA-46) | [#28](https://github.com/getmodern-ai/graft/pull/28) | 2026-09-11 | the console wears Cando's shell, page frame and auth doors |
| [GRA-47](https://linear.app/get-modern/issue/GRA-47) | [#30](https://github.com/getmodern-ai/graft/pull/30) | 2026-09-11 | screens follow Cando's patterns: data tables, settings rows, empties, toasts and status chips |
| [GRA-48](https://linear.app/get-modern/issue/GRA-48) | [#29](https://github.com/getmodern-ai/graft/pull/29) | 2026-09-11 | the OAuth callback page is drawn by the console |
| [GRA-49](https://linear.app/get-modern/issue/GRA-49) | [#27](https://github.com/getmodern-ai/graft/pull/27) | 2026-09-11 | GT Standard L and GT Standard Mono ship with the console |
| [GRA-52](https://linear.app/get-modern/issue/GRA-52) | [#31](https://github.com/getmodern-ai/graft/pull/31) | 2026-09-15 | destructive tools ask once; asking every time is an opt-in per tool |
| [GRA-53](https://linear.app/get-modern/issue/GRA-53) | [#33](https://github.com/getmodern-ai/graft/pull/33) | 2026-09-15 | MCP clients connect over OAuth and the consent mints the agent |
| [GRA-54](https://linear.app/get-modern/issue/GRA-54) | [#32](https://github.com/getmodern-ai/graft/pull/32) | 2026-09-15 | the handshake carries the playbook; instructions and descriptions stand in for the skill |
| [GRA-55](https://linear.app/get-modern/issue/GRA-55) | [#34](https://github.com/getmodern-ai/graft/pull/34) | 2026-09-15 | an elicitation the client cancels falls back to the handoff link |
| [GRA-81](https://linear.app/get-modern/issue/GRA-81) | [#58](https://github.com/getmodern-ai/graft/pull/58) | 2026-09-17 | sign in with Google or GitHub, through Cando's one door; ADR 0020 |
| [GRA-82](https://linear.app/get-modern/issue/GRA-82) | [#60](https://github.com/getmodern-ai/graft/pull/60) | 2026-09-18 | forgot password: Cando's email transport and the reset flow, Loops when a key is set; ADR 0021 |
| [GRA-90](https://linear.app/get-modern/issue/GRA-90) | [#65](https://github.com/getmodern-ai/graft/pull/65) | 2026-09-18 | mail is a seam: the vendor transport and its template ids leave the open core; ADR 0021 rewritten |
| [GRA-89](https://linear.app/get-modern/issue/GRA-89) | [#66](https://github.com/getmodern-ai/graft/pull/66) | 2026-09-18 | sign-in endpoints are not hosts: set aside before provider coverage, dropped from the row, named in the answer; ADR 0019 amended |
