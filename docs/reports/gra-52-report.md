# GRA-52 report (destructive tools ask once; asking every time is an opt-in), graft PR #31 + graft-docs PR #4

Saved by the orchestrator from the implementing agent's report, 2026-09-15.

## GRA-52 report

**PRs**
- Open repo: [getmodern-ai/graft#31](https://github.com/getmodern-ai/graft/pull/31), head `4d1d1b211be9d04478c4ed4eaf92b766407da123` (three commits: feature, docs/ADR, Greptile fix). CI `Typecheck, Lint & Test` green, CLA green, Greptile 5/5 on the head commit with both inline threads resolved. Reviewer `sebapoole` requested. Not merged.
- Docs repo: [getmodern-ai/graft-docs#4](https://github.com/getmodern-ai/graft-docs/pull/4), head `7892839d9c01a01c9e2c5d843a0aedc2fe2cf530`. No checks run on PRs there; `mint broken-links` clean locally. Body says not to merge before #31 lands (a push to `main` deploys). Not merged.
- GRA-52: In Review, both PRs linked, four screenshots attached, summary comment posted.

**Data-model decision.** `approval.per_call_relaxed` dropped, `approval.ask_every_call boolean NOT NULL DEFAULT false` added (migration `0004_approval_ask_every_call`, generated with drizzle-kit choosing "create column" over the rename prompt). Not rename-and-invert: inverting would have put every un-relaxed destructive allow into ask-every-call, the opposite of the ticket's "now holds that allow, with ask every time off". `decision` untouched, so no answer rewritten. The server's boot migrated the throwaway database "through 0004" on a real Postgres.

**Rule and API.** `approvalDecision`: read-only → pass; no row → ask; deny → deny; `askEveryCall` → ask; else pass. The flag applies to any non-read tool (write and destructive), and the card/form offer it on every tool ask. `PUT /approvals/:toolId/ask-every-call {"on": bool}` replaces the relax POST (400 read-only, 404 no row); `DELETE` unchanged; answer body `{ allow, askEveryCall? }` is a clean rename of `relax` (console and server ship together; absent leaves the setting as it stands, which is what a Hermes button carries). `ToolAskPayload.askEveryCall` carries the setting at ask time. Hermes: every accept records a standing allow, none touches the setting, the message says where it lives.

**Greptile fix (4d1d1b2).** Valid P1: with the setting on, a console yes waits unconsumed for the agent's next call; turning the setting off or withdrawing left it there, so a later call could re-create the allow. `setAskEveryCall` and `revokeApproval` now spend such answers (`settleAnsweredToolActions`, stamping `consumed_at`); `setApproval` takes the setting so the answer route and the gate write it in one upsert and never take that path. Valid P2: the `awaiting_approval` message is conditional on the setting. Also fixed the CI failure: the runner's skill suite pins "asks once, and the answer holds", which my first skill rewording had broken.

**Verified by hand** (server from the worktree on :3200, throwaway DB on :5440, console on :3001, fake sandbox): destructive httpbin tool published over MCP (check derived `destructive: true`); first call `awaiting_approval`; allow → two silent calls reached httpbin through the proxy, no open ask; `PUT on` → next call asks with `askEveryCall: true` on the payload; yes with setting on → one call passes, next asks again; `PUT off` → holds; withdraw then decline → `tool_denied` twice; malformed PUT 400, unknown tool 404; stale-answer fix: withdraw with a waiting yes → next call asks afresh, no row, old action `consumed_at` set. **Not verified by hand:** Hermes's real buttons over Discord (covered in `approval.test.ts`); the console switches were exercised via API and screenshots, not clicked.

**Screenshots** under graft-cloud `docs/screens/gra-52/`: `tool-ask-card-{light,dark}.png` (switch off, Destructive chip), `approvals-table-{light,dark}.png` (1440×2300, switch "Yes"), plus `tool-ask-card-setting-on-{light,dark}.png` (switch defaulting on). The first four are attached to GRA-52.

**Gate at head:** `check` clean, `lint` clean (two pre-existing warnings), `check-types` 18/18, `test --force` 18/18 `Cached: 0` (mcp 115, server 115 incl. Postgres integration, runner 55, web 100), `db:check-chain`, `drizzle-kit check` + no-op `generate`, `check-colours`, `check-tokens`, CI's conflict-marker and ADR scripts.

**For the orchestrator to decide**
- The ask-card switch and the elicitation `askEveryCall` field are offered on write tools too, not only destructive ones, matching the two-way column in the table. The ticket named destructive for the card; revert to destructive-only if that was intended.
- ADR 0006's GRA-42 bullet was edited in place (minimally, pointing at the amendment) since it asserted the old behaviour as current; ADR 0008 itself was only appended to.
- Docs `console/agents.mdx` also corrects a pre-existing inaccuracy: the Working set "Asks" column shows the annotation badge, not never/once/every call.
- Left in place: both worktrees; `apps/server/.env` in the open worktree (gitignored, throwaway secrets pointing at the now-dropped `graft_gra52`); the throwaway Playwright scripts in the orchestrator's temp directory. Cookie jar and agent token files were deleted.