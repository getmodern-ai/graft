# GRA-29 final report (`acquire` builds a tool with a scripted model), PR #16

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Branch `aleks/gra-29-acquire`; agent's last push `36470e0` (CI green 3m32s), orchestrator's update commit `9e2338c` after retargeting to `main`. Approved by sebapoole; Greptile posted nothing. Commits: `e3d99c0` interface (model seam, tables, shapes) · `e571ed7` the loop and runner · `cc6a351` merge of GRA-28 at 6c3a9e1 (migration renumbered 0002) · `81ff1fc` proxy value-based redaction · `47bb10d` the end-to-end suite and server wiring · `decf8f2` merge of GRA-28 at cae6650 · `36470e0` merge of main. Supersedes `gra-29-interface.md`.

## The model adapter, `@graft/model` (`packages/model/src/types.ts`)

```ts
type ModelAdapter = { readonly name: string; open(context: ModelJobContext): ModelConversation };
type ModelConversation = { turn(situation: ModelSituation): Promise<ModelReply> };
type ModelReply = { answer: ModelAnswer; usage: ModelUsage };          // usage = { inputTokens, outputTokens }, whole and ≥ 0
type ModelJobContext = { jobId; goal; hints: string | null; connection: ConnectionBrief; skill: string; budget: { maxAttempts; tokenCeiling } };
type ConnectionBrief = { id; vendor; displayName; scheme; primaryHost; hosts }; // never a credential
type ModelSituation =
  | { kind: "goal" } | { kind: "docs"; pages: DocPage[] }
  | { kind: "check_refused"; attempt; refusals: ModelDiagnostic[]; advice }
  | { kind: "proof"; attempt; reads: ProofRead[] }                    // every proof read, passed or failed
  | { kind: "publish_refused"; attempt; refusals; advice }
  | { kind: "dry_run_failed"; attempt; report: DryRunSummary | null; failure: string | null };
type ModelAnswer =
  | { kind: "read_docs"; urls: string[]; note } | { kind: "write_module"; draft: ModuleDraft; note } // every write_module is a new attempt
  | { kind: "proceed"; note }                                         // only after `proof`
  | { kind: "give_up"; reason };
type ModuleDraft = { name; description; inputSchema; files: { path; content }[]; testInput: object; proofReads: string[] /* vendor-relative GETs */ };
```

`ANSWERS_FOR` / `answerAllowed(situation, answer)` say what each situation admits; `isValidUsage`. The job owns every tool; the model only answers and never sees a credential or the token.

**Scripted backing** (`@graft/model/scripted`): `createScriptedModel(steps, { name?, defaultUsage? })`, `ScriptedStep = { on: ModelSituationKind; answer: ModelAnswer; usage?: ModelUsage }`, played in order per `open()`; a mismatched step throws `ScriptMismatchError`, an exhausted script `ScriptExhaustedError` (both become `model_failed`); `conversations` records what each conversation was shown. Default usage 500/100. `parseScript(json)` reads `{ "steps": [...] }` or a bare array (the `GRAFT_MODEL_SCRIPT` file). **Conformance** (`@graft/model/conformance`): `modelConformance(name, () => Promise<{ adapter, close? }>)`, four cases; `CONFORMANCE_CONTEXT`, `CONFORMANCE_PAGE`, `draftProblems(draft)`.

## Tables (`packages/db/src/schema/acquire-job.ts`; migration `0002_acquire_attempts_and_traces`)

- `acquire_job` +`hints`, `started_at`, `heartbeat_at`, `finished_at`, `tool_id` (FK authored_tool, set null); index on `(status, heartbeat_at)`.
- `acquire_attempt`: `id`, `job_id` (cascade), `agent_id` (cascade), `attempt_number`, `draft_path` (`.drafts/<jobId>/a<N>`), `files` jsonb, `check_output` jsonb, `version_id` (FK tool_version, set null; its row holds the dry-run report), `diagnosis`, `outcome` ∈ `running|passed|check_refused|proof_failed|publish_refused|dry_run_failed|run_failed|abandoned`, `input_tokens`, `output_tokens`, `finished_at`, owner/created/updated; unique `(job_id, attempt_number)`.
- `acquire_trace` (append-only): `id`, `job_id`, `agent_id`, `attempt_number` (nullable), `sequence` (per job, computed in the insert), `kind` ∈ `progress|model|docs|edit|check|proof|vendor_error|publish|dry_run|diagnosis|result`, `text`, `data` jsonb, `redacted`; unique `(job_id, sequence)`.
- Repos: `insertAcquireAttempt/updateAcquireAttempt/listAcquireAttempts`, `insertAcquireTrace/listAcquireTraces`, `addAcquireJobTokenSpend`, `heartbeatAcquireJob`, and the two unscoped-by-name statements `listRunnableAcquireJobs(db, { staleBefore, limit })` (joined to `agent` for the person) and `claimAcquireJob(db, id, { now, staleBefore })`, all pinned in `scope.test.ts`.

## Services (`@graft/core`, `ctx` first, `deps: AcquireJobDeps` last, required)

`createAcquireJob(ctx, scope, { connectionId, goal, hints?, firstProgressLine? }, deps)` · `recordAcquireJobTokens(ctx, scope, id, { inputTokens, outputTokens }, deps)` · `heartbeatAcquireJob(ctx, scope, id, deps)` · `completeAcquireJob(ctx, scope, id, { status, result, toolId?, traceRef? }, deps)` (stamps `finishedAt`) · `claimRunnableAcquireJobs(ctx, { staleAfterMs, limit }, deps): RunnableAcquireJob[]` · `startAcquireAttempt(ctx, scope, jobId, { draftPath: (n) => string, files, diagnosis?, redaction? }, deps)` (increments `attempts` in the same transaction) · `finishAcquireAttempt(ctx, scope, attemptId, { outcome, checkOutput?, versionId?, diagnosis?, usage?, redaction? }, deps)` · `listAcquireAttempts` · `appendAcquireTrace(ctx, scope, jobId, { attemptNumber?, kind, text, data?, redaction? }, deps)` (redacts text and data, bounds text at 8000 chars) · `listAcquireTraces(ctx, scope, jobId, limit, deps)`. Redaction (`redaction.ts`): `redactText`, `redactValue`, `secretFieldNamesFor(scheme, schemeConfig)`, `RedactionRule = { secretValues?, secretFieldNames? }`, marker `[redacted]`.

**Proxy** (orchestrator's direction): `packages/proxy/src/echo.ts` redacts every injected value (stored, derived, basic-auth base64) by value in response headers and text-like bodies → `[redacted:credential]`, header `x-graft-redacted: credential`, `ProxyEvent.credentialEchoed`; binary bodies untouched. ADR 0010 amended; the core redaction is the shape-based second line.

## `acquire` / `acquire_status` (`packages/mcp/src/acquire/shapes.ts`, exported from `@graft/mcp`)

- `acquire { connectionId, goal, hints? }` → `{ jobId, status: "queued" | "running", progress: [FIRST_PROGRESS_LINE] }`. Refusals `{ error: "refused", reason, message }`: `input_invalid`, `connection_not_in_scope` (points at `request_connection`), `acquire_unconfigured` (no model). The build ask returns GRA-23's `awaiting_approval` / `approval_declined` bodies verbatim.
- `acquire_status { jobId }` → `{ jobId, status: queued|running|succeeded|failed, progress: string[], attempts, result? }`; `job_not_found` refusal.
- `AcquireSuccess = { tool: "<vendor>__<name>", toolId, version, annotations: { readOnlyHint, destructiveHint } }`; `AcquireFailure = { failure, message, lastDiagnostics, tried: [{ attempt, outcome, summary }] }`, `failure` ∈ `attempt_budget | token_ceiling | turn_budget | model_gave_up | model_failed | connection_unavailable | build_approval_missing | sandbox_unavailable | job_failed`.
- `McpDeps` gains `acquireJob` (required; fake deps provide it), `model?: ModelAdapter | null`, `acquire?: { maxAttempts, tokenCeiling }` (`DEFAULT_ACQUIRE_CONFIG` 4/400000), `acquireRunner?: { kick() }`. `promotePublished(ctx, scope, toolId, deps, notifier)` is the one promote-and-notify both `publish_tool` and the job use.

## Env (`@graft/env`)

`GRAFT_ACQUIRE_MAX_ATTEMPTS` (4, 1..20; every draft is an attempt), `GRAFT_ACQUIRE_TOKEN_CEILING` (400000, ≥1000), `GRAFT_ACQUIRE_CONCURRENCY` (2, 1..32), `GRAFT_MODEL_BACKEND` (enum `scripted`, optional; GRA-31 extends) all-or-nothing with `GRAFT_MODEL_SCRIPT`, both refused in production.

## The runner and the loop (`packages/mcp/src/acquire/`)

`createAcquireRunner(deps, { concurrency, pollIntervalSeconds? 15, staleAfterSeconds? 120, heartbeatMs? 15000, onEvent?, onError? })` → `{ kick, start, stop, idle, running }`. `apps/server/src/index.ts` builds it after `createMcpDeps`, sets `mcp.acquireRunner`, calls `start()` (poll timer + one kick, so a restart picks up queued jobs and running jobs whose heartbeat went stale) and `stop()` on SIGTERM. `acquire` kicks it as a job is queued. `runAcquireJob(deps, claimed)` holds `inFlight.begin(agentId)` for its whole length, heartbeats, and runs the loop: docs via `readWebPage` (≤5 per turn) → `write_module` opens an attempt, writes the draft to the agent's sandbox, checks, runs ≤5 proof reads through a probe module under `runWithCapability(claim "execute", dryRun)`, publishes through `deps.publishTool`, dry-runs via `runAuthoredTool`; on pass, `promotePublished` + `completeAcquireJob(succeeded)`. Bounds: attempts, tokens (per turn, against the database's figure), turn budget `6·maxAttempts + 6`.

## Verified

- Suite: `packages/mcp/src/acquire.test.ts` (11 cases) covers every acceptance criterion through the SDK client, including the planted-credential test end to end through the real proxy with a key of no recognisable shape, and the SDK criterion against the real check. Full gate: check, lint (only GRA-23's two pre-existing warnings), check-types 17/17, drizzle check/generate clean, `db:check-chain` continuous (0000, 0001 GRA-28, 0002), `test --force` 17/17 `Cached: 0`.
- By hand, against `graft_gra29` on port 5440, fake sandbox, scripted model, a `github` connection to `api.github.com`: build ask → answered through `POST /api/pending-actions/:id/answer` → job id at once → `acquire_status` succeeded with 7 progress lines → `tools/list_changed` → `github__get-repo` first-class returned live GitHub data; Postgres holds 1 job, 1 attempt, 18 traces, the version's dry-run report.
- Not by hand: the Docker sandbox backing under the loop, a provider-backed model, an actual server restart (the resume path is exercised in the suite with a planted stale row).

## Deferred / notes

- Console read routes for attempts and traces (rows exist; a console follow-up).
- Provider-backed `ModelAdapter` and evals (GRA-31), which should run `modelConformance`.
- Two concurrent jobs of one agent naming the same tool race on the version number (GRA-18's note).
- Server wiring landmarks for conflict resolution: the `model` block before `createMcpDeps`, the `model`/`acquire` fields in it, the `createAcquireRunner` block after it, `acquireRunner.start()` before `serve`, and `acquireRunner.stop()` in the signal handler.
- Database `graft_gra29` left on the shared 5440 Postgres.
