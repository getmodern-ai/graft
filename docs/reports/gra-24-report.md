# GRA-24 final report (the working set contracts by cap and idle window), PR #10

Saved by the orchestrator from the implementing agent's report, 2026-09-09. Branch `aleks/gra-24-working-set-sweep`, final SHA `c30c4ccb25209be4d3e3812e9b2408ac9e43344b`. Paths are repo-relative.

## `sweepDecision` (`packages/core/src/working-set/sweep.decision.ts`)

```ts
sweepDecision({ entries: { toolId; promotedAt: Date; lastUsedAt: Date | null }[],
                cap, idleWindowDays, now: Date, inFlight: boolean })
  → { demote: { toolId; cause: "idle" | "cap" }[] }
```

- `inFlight` → `{ demote: [] }`.
- **Idle:** last use (promotion if never used since) strictly older than `now − idleWindowDays` → `idle`. Exactly-the-window is not past it.
- **Cap:** of what remains, if count > cap, the least recently used beyond the cap → `cap`, never a tool used inside the window. A promotion is not a use, so the cap's candidates are tools promoted inside the window and not yet called, oldest promotion first. A set of fresh tools may exceed the cap until it ages; the comment records "the cap is a backstop, not a hard limit (ADR 0009)". If promotion counted as use, the cap could never fire after the idle pass.
- A `lastUsedAt` before `promotedAt` is read as no use of this promotion (the ledger spans promote/demote cycles).
- Ties: promotion time, then tool id; output order deterministic and input-order-independent.

## In-flight registry (`packages/mcp/src/in-flight.ts`, `McpDeps.inFlight`)

`begin(agentId) → release()` (idempotent), `track(agentId, processName, ttlMs)`, `settle(agentId, processName)`, `has(agentId)`, `close()`. One per process, in-process by design (GRA-1 "No Temporal"); the header says a durable engine moves it. Every call path holds via one wrapper `heldInFlight`: `runAuthoredTool` (first-class, `run_tool`, publish's dry run), `execute__*`, `run_command`. A detached start is tracked by process name for `(timeoutSeconds + WAIT_SLACK_SECONDS)` seconds and settled when `wait_for_process` reports `completed | failed | killed`. `McpDeps.notifier` was added beside it (both optional, at the end; `createMcpDeps` makes both; `createMcpHttpApp` uses `deps.notifier` and only falls back to its own).

## Sweep (`packages/mcp/src/sweep.ts`)

`runSweep(ctx, deps, now, { apply?: boolean })` → `{ at: string; agents: number; skipped: string[]; demoted: { agentId; toolId; cause }[]; failed: { agentId; error }[] }`. Roster: new `listAllActiveAgents(db)` in `@graft/db/repo/agent` (the second deliberate unscoped read, pinned by name in `scope.test.ts`) and `listActiveAgentScopes(ctx, deps: Pick<AgentDeps,"listAllActiveAgents">)` in core. Per agent: skip if `inFlight.has`, read working set + `lastUsedAtByTool` (later clock wins), apply decision, `demoteTool(…, cause)`, notify once if anything changed; a throwing agent lands in `failed`, the rest are swept. `startSweep(deps, { intervalSeconds, now?, onReport?, onError? })` → `{ runNow(), stop() }`, unref'd interval, never two at once. `apps/server` starts it at boot and stops it on SIGTERM. Dev script: `pnpm --filter @graft/server sweep [-- --plan]` prints the report (`--plan` decides without demoting; it cannot see a running server's registry or notify its sessions).

## Env

`GRAFT_SWEEP_INTERVAL_SECONDS`, whole seconds ≥ 1, default 300, in `packages/env/src/schema.ts` with tests.

## Endpoint for the console (GRA-26)

`GET /api/agents/:id/working-set/changes?limit=` (1..500, default 50), person's session, 404 for another person's agent, revoked agents still answer. Body: `{ changes: [{ id, change: "promote"|"demote", cause: "agent"|"publish"|"idle"|"cap"|"revoke", createdAt, tool: { id, vendor, name, description } | null }] }`, newest first. `ApiDeps` gained `workingSet` and `tool`.

## Things GRA-23 and later tickets should know

- `AgentDeps.listAllActiveAgents` is a **required** new field (repo pattern); the three fakes (`agent.service.test.ts`, `api.test.ts`, `mcp/testing/fake-deps.ts`) got one line each. Any branch with its own fakes needs the same line on merge.
- Defaults unchanged from GRA-6 (cap 20 / 21 days); the row overrides. `Sweep` added to CONTEXT.md; AGENTS.md documents the sweep, the env var and the script.

## Verified

`check`, `lint`, `check-types` 15/15, `test --force` `Cached: 0` 15/15 (mcp 60 incl. `sweep.test.ts` 9 and `in-flight.test.ts` 6; core decision suite; server `sweep.test.ts` reads a sweep's demotion back through the history route with cause `idle`). Integration suite against Postgres on 5440: 40/40, none skipped. Greptile posted nothing.
