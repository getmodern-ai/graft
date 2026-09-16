# GRA-55 report (a cancelled elicitation falls back to the handoff), graft PR #34 + graft-docs PR #7

Saved by the orchestrator from the implementing agent's report, 2026-09-16.



**PRs**
- Open repo: [getmodern-ai/graft#34](https://github.com/getmodern-ai/graft/pull/34), head `f647a4023a916d517d5bad024726cecd1c394982` (two commits: the feature, then Greptile's P1). CI `Typecheck, Lint & Test` green on both heads, CLA green, Greptile **5/5** on the head with its one thread resolved. Reviewer `sebapoole` requested; `reviewDecision=APPROVED` (approval given on the first commit `c9f880a`), merge state `CLEAN`. **Not merged.**
- Docs: [getmodern-ai/graft-docs#7](https://github.com/getmodern-ai/graft-docs/pull/7), head `2838c80`, `mint broken-links` clean. Body says not to merge before #34 lands (a push to docs `main` deploys). Not merged.
- GRA-55: In Review, both PRs linked, two comments posted (the delivery record and the Greptile follow-up).

**The rule as implemented** (`packages/mcp/src/approval.ts`). `askByElicitation` returns `null` on `cancel` — the same value the pre-existing schema-mismatch/`catch` path returns — so `askApproval` falls through to the handoff: the result is the `awaiting_approval` body with the console URL, byte-for-byte what a no-elicitation client gets, and a pending action stands. Nothing recorded. `decline` still records the standing deny (plain refusal on a build ask); `accept` and the GRA-42 empty-accept mapping unchanged. Tool ask and build ask (`acquire`, `execute__<conn>`) share it. One `console.info` line marks the fall-through.

**Scope: per ask, not per session.** Nothing remembers the cancel; ADR 0006's amendment of 2026-09-16 records why (the doomed round trip is milliseconds; a sticky memory would take forms away from a person who closed one; the console's answer writes the approval row so the call after a console answer passes at the rule anyway). No session refinement added.

**Greptile's P1, fixed in the second commit.** With the fall-through, an elicitation client's earlier ask can be waiting in the console, answered and unconsumed by design (a per-call yes waits for the agent); the next call offered the form *first*, so a form answer could overtake the console's and leave that yes to be spent on a later call. Now `askApproval` looks up the waiting action before choosing a channel (`findWaitingAsk`) and skips the form when it is already answered; an open ask is still offered in place, and the handoff reuses its row. Greptile's sequence is a test; the amendment gains the paragraph.

**Tests** (`approval.test.ts`, 55 with `session.test.ts`): a fifth agent "headless Claude Code" covers the tool ask and the build ask on `cancel` — link, row, nothing recorded, same open action on the next ask, no second form after the console answers, the call then running; the build ask's `decline` gains its own case; accept/decline/GRA-42/schema-mismatch cases untouched.

**Hermes.** Buttons never send `cancel` (GRA-42), so unaffected. Nuance stated in the ADR and PR: ADR 0006 records Hermes's *no-answer* path as `cancel`; that path now yields a link rather than the card again. `SERVER_INSTRUCTIONS` and `SKILL.md` never described cancel; the GRA-54 alignment suite passes unchanged.

**Live check** (Claude Code 2.1.263, `claude -p --mcp-config --strict-mcp-config`, worktree server on :3200, throwaway DB on the compose Postgres, fake sandbox, a **dummy** model key so `acquire` reaches the gate without any model call, httpbin connection). Server log at the build ask: `mcp: elicitation cancelled by the client for code runs against httpbin (httpbin) for this agent, falling back to a handoff` then `POST /mcp 200 in 25.03s`. Claude, 6 turns (`find_tool` → `acquire`): *"This one's yours — Graft needs your approval before it can author and run code against the httpbin connection: http://localhost:3200/pending/50384694-…?t=… Open that in the Graft console and approve it … Tell me when you've answered and I'll rerun the acquire."* `GET /api/pending-actions` showed the unanswered `build` row. Under GRA-54's build the same drive ended in "dismissed without answering". Cost ~$0.20 Claude-side, zero Graft-side.

**Gate** (twice, from the worktree root): `check`, `lint` (two pre-existing `useOptionalChain` warnings at `approval.ts:560/576`), `check-types` 18/18, `test --force` 18/18 with `Cached: 0` (Postgres suites against :5440), `check-colours`, `check-tokens`, CI's marker and ADR scripts.

**Cleanup.** Server stopped, `graft_gra55` dropped, token/config/cookie files removed, no `claude mcp add` entry was ever created. Both worktrees left in place (`gra-55` in graft and in graft-docs). The worktree's gitignored `apps/server/.env` holds only generated throwaway secrets and the dummy key — no real secret was copied.

**For the orchestrator to decide**
- Merge of #34 (approval predates the second commit; whether it counts as stale depends on the ruleset), then #7.
- The Hermes no-answer nuance above: the ticket's AC says Hermes never sends `cancel`, which is true of its buttons; if its timeout path really does send `cancel`, that path now behaves better, not worse, but you may want the AC wording adjusted.