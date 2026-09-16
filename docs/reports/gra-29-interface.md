# GRA-29 interface half (acquire), pushed at e3d99c0c01bf93daa38e0620165d7f9e144a1dd7 on `aleks/gra-29-acquire` (stacked on gra-23)

Saved by the orchestrator from the implementing agent's interim report, 2026-09-09. The loop and the runner follow in later commits; any change to what is below is prefixed `interface:`. Final report will be `gra-29-report.md`.

## Model adapter, new package `@graft/model` (`packages/model/src/types.ts`)

- `ModelAdapter = { readonly name: string; open(context: ModelJobContext): ModelConversation }`, `ModelConversation = { turn(situation: ModelSituation): Promise<ModelReply> }`, `ModelReply = { answer: ModelAnswer; usage: ModelUsage }`, `ModelUsage = { inputTokens: number; outputTokens: number }` (whole, non-negative; the job sums them against the ceiling).
- `ModelJobContext = { jobId, goal, hints: string | null, connection: ConnectionBrief, skill: string (authoring-a-tool SKILL.md text), budget: { maxAttempts, tokenCeiling } }`; `ConnectionBrief = { id, vendor, displayName, scheme, primaryHost, hosts }`, never a credential.
- `ModelSituation` (the job puts these): `{ kind: "goal" }` | `{ kind: "docs"; pages: DocPage[] }` | `{ kind: "check_refused"; attempt; refusals: ModelDiagnostic[]; advice }` | `{ kind: "proof"; attempt; reads: ProofRead[] }` | `{ kind: "publish_refused"; attempt; refusals; advice }` | `{ kind: "dry_run_failed"; attempt; report: DryRunSummary | null; failure: string | null }`.
- `ModelAnswer`: `{ kind: "read_docs"; urls: string[]; note }` | `{ kind: "write_module"; draft: ModuleDraft; note }` (every write_module is a new attempt) | `{ kind: "proceed"; note }` (only after `proof`) | `{ kind: "give_up"; reason }`. `ANSWERS_FOR` / `answerAllowed(situation, answer)` say which answers a situation admits.
- `ModuleDraft = { name (kebab), description, inputSchema (type object), files: { path, content }[] (index.ts + optional package.json), testInput: object, proofReads: string[] (vendor-relative GET paths run through the execute path with the dry-run claim) }`.
- Scripted backing `@graft/model/scripted`: `createScriptedModel(steps: ScriptedStep[], { name?, defaultUsage? })` where `ScriptedStep = { on: ModelSituationKind; answer: ModelAnswer; usage?: ModelUsage }`, played in order per `open()`; a mismatched `on` throws `ScriptMismatchError`, an exhausted script `ScriptExhaustedError`; `parseScript(json)` reads `{ steps: [...] }` or a bare array (what `GRAFT_MODEL_SCRIPT` names). Default usage 500 in / 100 out.
- Conformance `@graft/model/conformance`: `modelConformance(name, () => Promise<{ adapter, close? }>)`, 4 vitest cases (names itself; drafts a valid module from goal + ≤3 doc rounds; answers check_refused and dry_run_failed with write_module/give_up/read_docs, never proceed; conversations independent). `CONFORMANCE_CONTEXT`, `CONFORMANCE_PAGE`, `draftProblems(draft)` exported.

## Tables (`packages/db/src/schema/acquire-job.ts`; migration `0001_acquire_attempts_and_traces`)

- `acquire_job` gains `hints text`, `started_at`, `heartbeat_at`, `finished_at`, `tool_id` (FK authored_tool, set null).
- `acquire_attempt`: id, job_id (FK cascade), agent_id (FK cascade), attempt_number, draft_path (`.drafts/<jobId>/a<N>`), files jsonb, check_output jsonb, version_id (FK tool_version set null; the row that holds the dry-run report), diagnosis text, outcome enum `running|passed|check_refused|proof_failed|publish_refused|dry_run_failed|run_failed|abandoned`, input_tokens, output_tokens, finished_at, owner/created_at/updated_at; unique (job_id, attempt_number).
- `acquire_trace`: id, job_id, agent_id, attempt_number (nullable), sequence (per job, computed in the insert), kind enum `progress|model|docs|edit|check|proof|vendor_error|publish|dry_run|diagnosis|result`, text, data jsonb, redacted boolean, owner/created_at (append-only); unique (job_id, sequence).

## Answer shapes (`packages/mcp/src/acquire/shapes.ts`, exported from `@graft/mcp`)

- `acquire { connectionId, goal, hints? }` → `{ jobId, status: "queued" | "running", progress: string[] }`; refusals `{ error: "refused", reason, message }` with reason `input_invalid | connection_not_in_scope (points at request_connection) | acquire_unconfigured (no model)`; the build ask returns GRA-23's `awaiting_approval` / `approval_declined` bodies verbatim.
- `acquire_status { jobId }` → `{ jobId, status: queued|running|succeeded|failed, progress: string[], attempts: number, result?: AcquireSuccess | AcquireFailure }`; `job_not_found` refusal.
- `AcquireSuccess = { tool: "<vendor>__<name>", toolId, version, annotations: { readOnlyHint, destructiveHint } }`; `AcquireFailure = { failure: AcquireFailureKind, message, lastDiagnostics: unknown, tried: [{ attempt, outcome, summary }] }` with `ACQUIRE_FAILURES = attempt_budget | token_ceiling | turn_budget | model_gave_up | model_failed | connection_unavailable | build_approval_missing | sandbox_unavailable | job_failed`.
- `McpDeps` gains `acquireJob: AcquireJobDeps` (required; fake deps provide it), `model?: ModelAdapter | null`, `acquire?: { maxAttempts, tokenCeiling }` (`DEFAULT_ACQUIRE_CONFIG` 4 / 400000), `acquireRunner?: { kick(): void }`.

## Env

`GRAFT_ACQUIRE_MAX_ATTEMPTS` (default 4, 1..20), `GRAFT_ACQUIRE_TOKEN_CEILING` (400000, ≥1000), `GRAFT_ACQUIRE_CONCURRENCY` (2, 1..32), `GRAFT_MODEL_BACKEND` (enum `scripted`, optional; GRA-31 extends) all-or-nothing with `GRAFT_MODEL_SCRIPT` (path), both refused in production.

## Core services added (`packages/core/src/acquire-job`)

`recordAcquireJobTokens`, `startAcquireAttempt`, `finishAcquireAttempt`, `listAcquireAttempts`, `appendAcquireTrace` (redacts text+data), `listAcquireTraces`, `heartbeatAcquireJob`, `claimRunnableAcquireJobs`; `redactText/redactValue/secretFieldNamesFor` in `redaction.ts`. The job never holds the credential's value (decrypt stays in the proxy binding), so job-side redaction is by known token values, Authorization/Bearer/Basic, JWT shape, scheme-table field names and well-known key shapes. Orchestrator's direction: value-based redaction of an echoed credential is the proxy's job on the response path (see gra-29-report.md when it lands).
