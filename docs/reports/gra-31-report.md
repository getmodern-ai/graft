# GRA-31 final report (a real model authors, the evals score it, the Hermes skill points at it), PR #19

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Branch `aleks/gra-31-provider-model-evals-skill`, SHA `ea10090dc06b87e274b1598c28e192510a09da83`, merged into `main` as `f3b1ef5`. Approved by sebapoole, CI green, Greptile silent. Interface changes to GRA-29's seam: `ModelJobContext.personId` (required); the conformance suite is no longer re-exported from `@graft/model`'s index (import `@graft/model/conformance`).

## Provider adapter (`@graft/model/provider`: `packages/model/src/provider.ts`, `answer.ts`, `prompt.ts`, `triage.ts`)

`createProviderModel({ provider: "anthropic" | "openai", apiKey, authoringModel?, triageModel?, baseUrl? }, { telemetry?, models? })`. The authoring model takes every situation; the triage model decides whether the job opens with `read_docs` (only URLs present in goal/hints) and condenses pages over 8,000 chars; it never writes code. Structured output via `Output.object` over a flat wire schema (input schema and test input as JSON text, since strict modes take no free-form objects); one repair turn, then `ModelAnswerInvalidError` → `model_failed`. Defaults: Anthropic `claude-fable-5-1` / `claude-haiku-4-5-20251001`; OpenAI `gpt-5.6-sol` / `gpt-5.4-mini` (both confirmed on the live models list). `baseUrl` on OpenAI selects Chat Completions (gateway contract). Conformance: mock in `pnpm test`; live 4/4 via `pnpm --filter @graft/model test:live`. `@graft/model/routed` puts a person's key in front of the fixed model.

## Env (`packages/env/src/schema.ts`)

`GRAFT_MODEL_BACKEND` = `scripted | provider`; `GRAFT_MODEL_PROVIDER` + `GRAFT_MODEL_API_KEY` read together under `provider`, refused outside it; `GRAFT_MODEL_AUTHORING`, `GRAFT_MODEL_TRIAGE`, `GRAFT_MODEL_BASE_URL` optional; `GRAFT_LANGFUSE_PUBLIC_KEY` + `GRAFT_LANGFUSE_SECRET_KEY` all-or-nothing, `GRAFT_LANGFUSE_BASE_URL` its own; `NODE_ENV=production` + `GRAFT_BACKINGS=open` refuses boot without the provider group, naming both variables (ADR 0014); `PLACEHOLDER*` secrets refused. One self-host rule after the merges (GRA-33's stub removed). GRA-33's `.env.example` corrected to the verified ids plus a Langfuse block.

## BYO key

Table `person_model_key` (migration `0003`, one row per person, `{ apiKey }` encrypted under scope `{ personId, connectionId: "person-model-key" }` via the vault's encrypt half); routes `GET`/`PUT`/`DELETE /api/me/model-key` (`apps/server/src/api.ts`); core `packages/core/src/model-key/`; resolver `apps/server/src/model.ts` (the one decrypt outside the proxy binding; routing whenever a fixed model exists and always under `cloud`; `model.test.ts` proves person A's key never answers person B's job); console Settings screen `apps/web/src/routes/_auth/_shell/settings.tsx` + `components/settings/model-key-card.tsx`.

## Langfuse (`@graft/model/langfuse`)

Cando's pattern, per call: `traceName acquire-authoring|acquire-triage`, `sessionId = jobId`, `userId = personId`, tags `[provider, role, situation]`, metadata `{ jobId, personId, attempt, situation, role, provider, modelId }`, same fields on spans via `runtimeContext` + `includeRuntimeContext`. Verified with a double; live check deferred (no Graft Langfuse project; Cando's keys not copied).

## Evals (`packages/evals`)

`src/world.ts` (fake vendors behind the real proxy, real check/publish, fake sandbox with a lockfile-writing install and the SDK linked onto the toolbox path), `scenarios.ts` (read, write, sdk), `scorers.ts` (the five properties + supporting), `run-scenario.ts`, `scorecard.ts`, `eval.ts`, `scripted-answers.ts`, tests. `pnpm --filter @graft/evals eval [--scenario x] [--scripted]`; a no-key run explains and exits 1 without opening anything. **Live scorecard (OpenAI key): read PASS 23,242 tokens; write PASS 23,524 (POST previewed; first real order through `demo__create-order` after the yes); sdk PASS 17,040 (Octokit bound to the proxy, check accepted, vendor saw its bearer on `/repos/...`, never the token); every scorer green.** Spend: 96,335 tokens over five runs; the three counting runs 63,806. Two harness failures fixed between runs: GRA-29's `prove()` returned `{ ...reads }` (fixed in `packages/mcp/src/acquire/job.ts`, pinned in the acquire suite), and the harness now fills tool input from the published schema.

## Hermes skill

`skills/hermes-graft/SKILL.md` (+ `README.md`, pointer line to GRA-30's `connecting-with-oauth.md`). `mcp_servers` block:

```yaml
mcp_servers:
  graft:
    url: "https://your-graft.example/mcp"
    headers:
      Authorization: "Bearer ${GRAFT_TOKEN}"
```

## Verified live

All three eval scenarios, model conformance, the Postgres integration suite 111/111 on the final tree, full gate (`check`, `lint` with GRA-23's two pre-existing warnings, `check-types` 18/18, drizzle check/generate, `db:check-chain` through 0003, `test --force` 18/18 `Cached: 0`), CI green.

## Deferred

- **The Hermes criterion.** Two runs: the skill loaded, Graft's 17 tools registered as `mcp__graft__*`, `find_tool` was called first, and Graft's build ask arrived as an **MCP elicitation Hermes rendered as a prompt** (the first confirmation of the elicitation channel on a launch harness; ADR 0006 and GRA-25 assumed none), but `gpt-5.4-mini` as the harness model drove `execute__<connection>` instead of `acquire`, and the second run's `-t skills` excluded MCP tools entirely. Exact corrected steps for the user are on GRA-31.
- Langfuse live check. The Docker sandbox under a real-model job.

## Machine state

Hermes home under `/tmp`, `~/.local/bin/hermes` and the `graft_gra31` database were removed. **Hermes' installer brew-installed `ffmpeg 9.0.1_1` with dependencies `dav1d, lame, libvmaf, libvpx, mpg123, opus, sdl3, sdl2-compat, svt-av1, x264, x265` and upgraded `ca-certificates`** (ripgrep was already present); the user decides whether to keep them (`brew uninstall ffmpeg && brew autoremove`). The worktree's gitignored `apps/server/.env` held the copied OpenAI key as `GRAFT_MODEL_API_KEY`; the orchestrator removed the worktree.
