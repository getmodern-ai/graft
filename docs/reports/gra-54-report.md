# GRA-54 report (the MCP handshake carries the playbook), graft PR #32 + graft-docs PR #5

Saved by the orchestrator from the implementing agent's report, 2026-09-15.

## GRA-54 report

**PRs**
- Open repo: [getmodern-ai/graft#32](https://github.com/getmodern-ai/graft/pull/32), head `c9deeb3214cb4c782daead4902ac571d6b2cb4d1` (two commits: the feature, then Greptile's one P2). CI `Typecheck, Lint & Test` green on both heads, CLA green, Greptile **5/5** on the head commit with its one thread resolved. Reviewer `sebapoole` requested; `reviewDecision=APPROVED` (approval given on the first commit). Not merged.
- Docs: [getmodern-ai/graft-docs#5](https://github.com/getmodern-ai/graft-docs/pull/5), head `a07b7560f69cd05f690b02f0efb9d892b8c6c1c7`. `mint broken-links` clean. Body says not to merge before #32 lands (a push to docs `main` deploys). Not merged.
- GRA-54: In Review, both PRs linked, two comments posted (the live-check record and the delivery summary).

**Final `SERVER_INSTRUCTIONS`, 1,774 characters (budget 1,800, `INSTRUCTIONS_BUDGET`)**

> Graft extends your tool list. Its tools there are your working set: the authored tools promoted for you, callable as vendor__name, plus these fixed ones.
>
> When a task has no tool, work in this order. Call find_tool first: a matching tool may exist and be demoted. If one matches, promote it; it is in your list at once, no authoring needed. If the vendor has no connection in your scope, call request_connection. Call acquire only when nothing fits, with the connection id and a goal. It answers a jobId before anything is built: poll acquire_status and relay the newest progress line in one sentence, only when it changed. Do not start a second acquire for the same goal, and do not drive the authoring tools (read_web_page, write_file, check_tool, publish_tool) or an execute__ tool unless the person asked you to author by hand; they build tools and do not answer the person.
>
> Any answer with a url and an awaiting_ word (approval, connection, credential) is a handoff: the next step is the person's, in the console. Send them the link exactly as returned, say what it is for, then wait; when they say it is done, call the same tool again with the same arguments. Never ask the person for an API key, a password or a token in chat, whatever the vendor calls it. The console is where secrets go; you never see one.
>
> Some clients snapshot the tool list per conversation, so a tool just promoted or acquired may be missing from yours: run_tool { vendor, name, input } calls it by name. Re-fetch the list on notifications/tools/list_changed.
>
> Approvals are the person's. A read-only tool never asks. Any other tool asks once, and the answer holds, a destructive tool too; the person can set a tool to ask every time in the console. acquire asks once per agent per connection.

**What changed** (7 files, +374/−54): `packages/mcp/src/session.ts` (instructions as five joined paragraphs plus `INSTRUCTIONS_BUDGET`), `tools/meta.ts`, `tools/authoring.ts` (`ADVANCED_WHEN` exported; `read_web_page` says it is for documentation while authoring, not a fetcher for the person), `tools/execute.ts` (by-hand path plus the build-ask handoff), new `session.test.ts` (29 tests: initialize carries instructions under budget; voice; order of operations; table-driven "when" per meta-tool with the key set pinned to the meta-tool set; handoff tools say `awaiting_`/"exactly as returned"/"call again"; authoring set starts with `ADVANCED_WHEN`; 21 shared sentences asserted in both the instructions and `skills/hermes-graft/SKILL.md`), the skill reworded where it differed, and one AGENTS.md paragraph. Tool names and input schemas unchanged. Alignment is by test, not by a shared module.

**Live check, Claude Code as a bare MCP client** (`claude -p --mcp-config --strict-mcp-config`, no skill, `Bash` and every fetcher disallowed, worktree server on :3200, throwaway DB, fake sandbox, `openai:gpt-5.6-sol`). Claude Code defers MCP schemas behind `ToolSearch`, so the model saw tool names plus the instructions until it loaded a tool: a strict test of the instructions.
- "What is my public IP according to httpbin?": `find_tool` → `acquire {connectionId, goal, hints: docs URL}` → `acquire_status` ×14 with each new line relayed ("It's authoring the tool against httpbin now." … "Published as `httpbin__get-public-ip` v1 — it's dry-running it now.") → client picked up the list change and called `httpbin__get-public-ip {}` first-class → `{"ip":"14.200.179.189"}`. No authoring tool, `execute__`, or `read_web_page` driven.
- Unconnected vendor ("open issues in getmodern-ai/graft"): `find_tool` ×2 → `request_connection {github, api.github.com, bearer, docsUrl}` → `awaiting_connection`; relayed: "**Open this link and enter a GitHub token:** http://localhost:3200/pending/<id>?t=<token> … **Don't paste the token here — it goes in the console only; I never see it.** Tell me once you've done it, and I'll continue."
- Two earlier attempts shaped wording (recorded on the ticket): with a shell allowed it tried `curl` first; without one, `acquire`'s build ask returned "dismissed without answering" because Claude Code advertises elicitation and auto-cancels it in `-p` mode, and the model then used `read_web_page` as a fetcher, which is now named in the do-not-drive list and its own description. The build approval was then raised through a non-elicitation client and answered via the API so the acquire flow could run.

**Model spend:** one acquire job, one attempt, 23,157 tokens on `gpt-5.6-sol` (a few cents). Claude-side `-p` runs cost about $1.10 in total across four attempts.

**Gate at head:** `check` clean, `lint` clean (two pre-existing warnings), `check-types` 18/18, `test --force` from the root 18/18 with `Cached: 0`, `check-colours`, `check-tokens`, CI's conflict-marker and ADR scripts; mcp suite 144 passed.

**Cleanup:** server stopped, `graft_gra54` dropped, token/MCP-config/cookie files removed, the copied model-key line removed from the worktree's gitignored `apps/server/.env` (rest left as GRA-52 did). No `claude mcp add` entry was ever created. Both worktrees left in place; GRA-53 has not landed, so no `origin/main` merge was needed.

**For the orchestrator to decide**
- A non-interactive client that advertises elicitation but cannot show it (Claude Code `-p`) can never approve anything: Graft correctly records nothing and asks again, but the person gets no link. If chat products behave the same way, an elicitation that comes back `cancel` might warrant falling through to the handoff URL. Not changed here; ADR 0006 territory.
- The `find_tool` empty-answer runtime `note` was changed alongside the description (Greptile's P2). It is prose only, no shape change.
- `sebapoole`'s approval predates the second commit; whether it is dismissed as stale depends on the ruleset. Merge is yours.